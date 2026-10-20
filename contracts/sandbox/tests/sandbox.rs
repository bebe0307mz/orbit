//! Sandbox integration harness (layer S): real nearcore sandbox, real access-key rules, nonces,
//! cross-contract receipts and NEP-141 refunds, with the `mock-ft` token.
//!
//! Prerequisite: `scripts/build-contracts.sh` (wasm under target/near/).
//! Run: `cargo test -p orbit-sandbox-tests --test sandbox -- --nocapture`
//! Filter scenarios: `ORBIT_ONLY=T-13,T-14`.
//!
//! One sandbox node, scenarios run sequentially, each on a fresh vault, token and accounts.
//! After every scenario the post-condition helper checks P1 to P8 (I7, I8, I9, I11).

use anyhow::{anyhow, bail, ensure, Context, Result};
use near_workspaces::network::Sandbox;
use near_workspaces::operations::Function;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccessKeyPermission, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Worker};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::pin::Pin;
use std::time::{Duration, Instant};

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const PAY_GAS: Gas = Gas::from_tgas(60);

fn wasm(name: &str) -> Vec<u8> {
    wasm_file(name, name)
}

fn wasm_file(dir: &str, file: &str) -> Vec<u8> {
    let p = format!("{}/../../target/near/{dir}/{file}.wasm", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&p).unwrap_or_else(|_| panic!("missing {p}: run scripts/build-contracts.sh"))
}

fn pid(tag: &str, n: u64) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(format!("{tag}-{n}").as_bytes()))
}

/// Outcome of one `pay` (or any call) as seen by the caller.
#[derive(Debug, Clone)]
enum Out {
    /// Final value (PayResult for pay).
    Ok(Value),
    /// A receipt panicked (E_* codes).
    Panic(String),
    /// Refused by the protocol before any receipt (MethodNameMismatch, AccessKeyNotFound, ...).
    Proto(String),
}

impl Out {
    fn status(&self) -> String {
        match self {
            Out::Ok(v) if v.get("status").is_some() => format!(
                "{}{}",
                v["status"].as_str().unwrap_or("?"),
                v["reason"].as_str().map(|r| format!(":{r}")).unwrap_or_default()
            ),
            Out::Ok(v) => v.to_string(),
            Out::Panic(m) => format!("panic:{}", short_err(m)),
            Out::Proto(m) => format!("proto:{}", short_err(m)),
        }
    }
}

fn short_err(m: &str) -> String {
    for code in [
        "E_AUTH", "E_DEPOSIT", "E_GAS", "E_ARGS", "E_STATE", "E_FUNDS", "E_STORAGE_LOW", "MethodNameMismatch",
        "AccessKeyNotFound", "DepositWithFunctionCall", "RequiresFullAccess", "InvalidNonce", "NotEnoughAllowance",
        "ReceiverMismatch",
    ] {
        if m.contains(code) {
            return code.to_string();
        }
    }
    m.chars().take(160).collect()
}

fn classify(r: Result<ExecutionFinalResult, near_workspaces::error::Error>) -> Out {
    match r {
        Err(e) => Out::Proto(format!("{e:?}")),
        Ok(res) if res.is_failure() => Out::Panic(format!("{:?}", res.into_result().unwrap_err())),
        Ok(res) => Out::Ok(res.json::<Value>().unwrap_or(Value::Null)),
    }
}

struct Agent {
    id: u32,
    sk: SecretKey,
    /// Signs as the vault account with this agent's FC key.
    acct: Account,
}

struct Env {
    w: Worker<Sandbox>,
    owner: Account,
    ft: AccountId,
    vault: AccountId,
    guardian_sk: SecretKey,
    guardian: Account,
    agents: Vec<Agent>,
    /// Registered on the token and allowlisted.
    m1: Account,
    /// Registered, never allowlisted.
    m2: Account,
    /// Allowlisted, never registered on the token (transfers to it fail).
    m3: Account,
    outsider: Account,
    revoked: BTreeSet<u32>,
    /// Allowance each live agent key was (re)registered with, for P7.
    allowances: BTreeMap<u32, u128>,
}

#[derive(Clone, Copy)]
struct Cfg {
    agents: u32,
    per_payment: u128,
    daily: u128,
    org: u128,
    deposit: u128,
}

impl Default for Cfg {
    fn default() -> Self {
        Cfg { agents: 4, per_payment: 100_000, daily: 250_000, org: 1_000_000, deposit: 10_000_000 }
    }
}

const AGENT_ALLOWANCE: u128 = 1_000_000_000_000_000_000_000_000; // 1 NEAR

async fn sub(root: &Account, name: &str, near: u128) -> Result<Account> {
    Ok(root
        .create_subaccount(name)
        .initial_balance(NearToken::from_near(near))
        .transact()
        .await?
        .into_result()?)
}

impl Env {
    async fn new(w: &Worker<Sandbox>, tag: &str, cfg: Cfg) -> Result<Env> {
        let root = w.root_account()?;
        let owner = sub(&root, &format!("{tag}-owner"), 20).await?;
        let m1 = sub(&root, &format!("{tag}-m1"), 5).await?;
        let m2 = sub(&root, &format!("{tag}-m2"), 5).await?;
        let m3 = sub(&root, &format!("{tag}-m3"), 5).await?;
        let outsider = sub(&root, &format!("{tag}-outsider"), 10).await?;

        // Token: otusd, owner can mint.
        let ft_acct = sub(&root, &format!("{tag}-ft"), 10).await?;
        ft_acct
            .batch(ft_acct.id())
            .deploy(&wasm("mock_ft"))
            .call(Function::new("new").args_json(json!({"owner": owner.id(), "symbol": "OTUSD"})))
            .transact()
            .await?
            .into_result()?;
        let ft = ft_acct.id().clone();

        // Vault: deploy + init in one tx with the deploy key K0, then delete K0.
        let k0 = SecretKey::from_random(KeyType::ED25519);
        let vault_acct = root
            .create_subaccount(&format!("{tag}-vault"))
            .initial_balance(NearToken::from_near(30))
            .keys(k0.clone())
            .transact()
            .await?
            .into_result()?;
        let vault = vault_acct.id().clone();
        let guardian_sk = SecretKey::from_random(KeyType::ED25519);
        vault_acct
            .batch(&vault)
            .deploy(&wasm("orbit_vault"))
            .call(
                Function::new("new")
                    .args_json(json!({
                        "owner": owner.id(),
                        "token": ft,
                        "guardian_pk": guardian_sk.public_key(),
                        "float_cap": "20000000",
                        "org_daily_limit": cfg.org.to_string(),
                    }))
                    .gas(Gas::from_tgas(300)),
            )
            .transact()
            .await?
            .into_result()?;
        for acc in [&vault, m1.id(), m2.id()] {
            owner
                .call(&ft, "storage_deposit")
                .args_json(json!({"account_id": acc, "registration_only": true}))
                .deposit(NearToken::from_millinear(10))
                .transact()
                .await?
                .into_result()?;
        }
        vault_acct.batch(&vault).delete_key(k0.public_key()).transact().await?.into_result()?;
        let guardian = Account::from_secret_key(vault.clone(), guardian_sk.clone(), w);

        let mut env = Env {
            w: w.clone(),
            owner,
            ft,
            vault,
            guardian_sk,
            guardian,
            agents: vec![],
            m1,
            m2,
            m3,
            outsider,
            revoked: BTreeSet::new(),
            allowances: BTreeMap::new(),
        };
        env.owner_call("add_merchant", json!({"account": env.m1.id(), "name": "Orbit Data"})).await?.ok()?;
        env.owner_call("add_merchant", json!({"account": env.m3.id(), "name": "Unregistered Shop"})).await?.ok()?;
        for i in 1..=cfg.agents {
            env.register(&format!("a{i}"), cfg.per_payment, cfg.daily).await?;
        }
        env.mint_and_deposit(cfg.deposit).await?;
        Ok(env)
    }

    async fn register(&mut self, name: &str, per_payment: u128, daily: u128) -> Result<u32> {
        self.register_with(name, per_payment, daily, AGENT_ALLOWANCE).await
    }

    async fn register_with(&mut self, name: &str, per_payment: u128, daily: u128, allowance: u128) -> Result<u32> {
        let sk = SecretKey::from_random(KeyType::ED25519);
        let out = self
            .owner_call(
                "register_agent",
                json!({"name": name, "public_key": sk.public_key(), "per_payment_limit": per_payment.to_string(),
                       "daily_limit": daily.to_string(), "allowance": allowance.to_string()}),
            )
            .await?;
        let id = out.ok()?.as_u64().ok_or_else(|| anyhow!("register_agent returned no id"))? as u32;
        let acct = Account::from_secret_key(self.vault.clone(), sk.clone(), &self.w);
        self.agents.push(Agent { id, sk, acct });
        self.allowances.insert(id, allowance);
        Ok(id)
    }

    fn agent(&self, id: u32) -> &Agent {
        self.agents.iter().find(|a| a.id == id).expect("agent")
    }

    async fn mint_and_deposit(&self, amount: u128) -> Result<Value> {
        self.owner
            .call(&self.ft, "mint")
            .args_json(json!({"account_id": self.owner.id(), "amount": amount.to_string()}))
            .transact()
            .await?
            .into_result()?;
        let r = self
            .owner
            .call(&self.ft, "ft_transfer_call")
            .args_json(json!({"receiver_id": self.vault, "amount": amount.to_string(), "msg": ""}))
            .deposit(ONE_YOCTO)
            .gas(Gas::from_tgas(100))
            .transact()
            .await?
            .into_result()?;
        Ok(r.json::<Value>()?)
    }

    async fn owner_call(&self, method: &str, args: Value) -> Result<Out> {
        Ok(classify(
            self.owner.call(&self.vault, method).args_json(args).deposit(ONE_YOCTO).gas(Gas::from_tgas(100)).transact().await,
        ))
    }

    async fn now_ms(&self) -> Result<u64> {
        Ok(self.w.view_block().await?.timestamp() / 1_000_000)
    }

    async fn pay(&self, agent: u32, id: &str, merchant: &AccountId, amount: u128) -> Result<Out> {
        let deadline = self.now_ms().await? + 120_000;
        Ok(classify(
            self.agent(agent)
                .acct
                .call(&self.vault, "pay")
                .args_json(json!({"payment_id": id, "merchant": merchant, "amount": amount.to_string(), "deadline_ms": deadline}))
                .gas(PAY_GAS)
                .transact()
                .await,
        ))
    }

    /// Hand-signed tx (signer = receiver = vault) so tests see raw protocol responses.
    async fn sign_raw(&self, sk: &SecretKey, nonce: u64, method: &str, args: &Value) -> Result<near_primitives::transaction::SignedTransaction> {
        use near_primitives::action::{Action, FunctionCallAction};
        use near_primitives::transaction::{SignedTransaction, Transaction, TransactionV0};
        let csk: near_crypto::SecretKey = sk.to_string().parse()?;
        let signer = near_crypto::InMemorySigner::from_secret_key(self.vault.as_str().parse()?, csk);
        let block = self.w.view_block().await?;
        let tx = Transaction::V0(TransactionV0 {
            signer_id: self.vault.as_str().parse()?,
            public_key: signer.public_key(),
            nonce,
            receiver_id: self.vault.as_str().parse()?,
            block_hash: near_primitives::hash::CryptoHash(block.hash().0),
            actions: vec![Action::FunctionCall(Box::new(FunctionCallAction {
                method_name: method.into(),
                args: serde_json::to_vec(args)?,
                gas: near_primitives::types::Gas::from_gas(PAY_GAS.as_gas()),
                deposit: near_primitives::types::Balance::from_yoctonear(0),
            }))],
        });
        let (hash, _) = tx.get_hash_and_size();
        Ok(SignedTransaction::new(signer.sign(hash.as_ref()), tx))
    }

    /// Broadcasts a hand-signed tx; Err carries the RPC/protocol error text.
    async fn broadcast_raw(&self, stx: &near_primitives::transaction::SignedTransaction) -> Result<std::result::Result<String, String>> {
        use near_jsonrpc_client::methods::broadcast_tx_commit::RpcBroadcastTxCommitRequest;
        let client = near_jsonrpc_client::JsonRpcClient::connect(self.w.rpc_addr());
        Ok(match client.call(RpcBroadcastTxCommitRequest { signed_transaction: stx.clone() }).await {
            Ok(o) => Ok(format!("{:?}", o.status)),
            Err(e) => Err(format!("{e:?}")),
        })
    }

    async fn state(&self) -> Result<Value> {
        Ok(self.w.view(&self.vault, "state").await?.json::<Value>()?)
    }

    async fn outcomes(&self, from: u64) -> Result<Value> {
        Ok(self.w.view(&self.vault, "outcomes").args_json(json!({"from_seq": from, "limit": 100})).await?.json::<Value>()?)
    }

    async fn ft_balance(&self, acc: &AccountId) -> Result<u128> {
        let v: String = self.w.view(&self.ft, "ft_balance_of").args_json(json!({"account_id": acc})).await?.json()?;
        Ok(v.parse()?)
    }

    fn agent_state<'a>(s: &'a Value, id: u32) -> &'a Value {
        s["agents"].as_array().unwrap().iter().find(|a| a["id"] == id).unwrap()
    }

    /// Post-condition helper (7-security-tests.md 5.2): P1 to P8.
    async fn check(&self, quiescent: bool) -> Result<()> {
        let s = self.state().await?;
        let keys = self.w.view_access_keys(&self.vault).await?;
        let bal = self.ft_balance(&self.vault).await?;
        let n = |v: &Value| -> u128 { v.as_str().unwrap().parse().unwrap() };
        let (avail, res, paid, wd, dep) =
            (n(&s["available"]), n(&s["reserved"]), n(&s["paid_total"]), n(&s["withdrawn_total"]), n(&s["deposited_total"]));
        ensure!(dep == avail + res + paid + wd, "P1 I7 conservation: {dep} != {avail}+{res}+{paid}+{wd}");
        ensure!(avail + res <= n(&s["float_cap"]), "P2 I8 float cap");
        let c = &s["counts"];
        ensure!(
            c["next_seq"].as_u64() == Some(c["paid"].as_u64().unwrap() + c["failed"].as_u64().unwrap() + c["rejected"].as_u64().unwrap()),
            "P3 I9 counters {c}"
        );
        let agents = s["agents"].as_array().unwrap();
        for k in ["paid", "failed", "rejected"] {
            let sum: u64 = agents.iter().map(|a| a[format!("{k}_count")].as_u64().unwrap()).sum();
            ensure!(sum == c[k].as_u64().unwrap(), "P4 agent {k} counts");
        }
        let agent_res: u128 = agents.iter().map(|a| n(&a["reserved"])).sum();
        let pend: u128 = s["pending"].as_array().unwrap().iter().map(|p| n(&p["amount"])).sum();
        ensure!(n(&s["org"]["reserved"]) == agent_res && agent_res == pend, "P5 org.reserved == agents == pending");
        ensure!(res >= n(&s["org"]["reserved"]), "P5 reserved >= org.reserved");
        ensure!(bal >= avail + res, "P6 token backing {bal} < {}", avail + res);
        // P7 I11: exact key set and permissions.
        let mut want: BTreeMap<String, (Vec<String>, u128)> = BTreeMap::new();
        want.insert(
            s["guardian_pk"].as_str().unwrap().to_string(),
            (vec!["pause_agent".into(), "pause_all".into()], 1_000_000_000_000_000_000_000_000),
        );
        for a in agents {
            let id = a["id"].as_u64().unwrap() as u32;
            if a["status"] != "revoked" {
                want.insert(a["pk"].as_str().unwrap().to_string(), (vec!["pay".into()], self.allowances[&id]));
            }
        }
        ensure!(keys.len() == want.len(), "P7 key count {} != {}", keys.len(), want.len());
        for k in &keys {
            let pk = k.public_key.to_string();
            let (methods, max) = want.get(&pk).ok_or_else(|| anyhow!("P7 unexpected key {pk}"))?;
            match &k.access_key.permission {
                AccessKeyPermission::FullAccess => bail!("P7 full access key on vault"),
                AccessKeyPermission::FunctionCall(fc) => {
                    ensure!(fc.receiver_id == self.vault.to_string(), "P7 receiver");
                    ensure!(&fc.method_names == methods, "P7 methods {:?} != {:?}", fc.method_names, methods);
                    let a = fc.allowance.ok_or_else(|| anyhow!("P7 unlimited allowance"))?.as_yoctonear();
                    ensure!(a > 0 && a <= *max, "P7 allowance {a} not in (0, {max}]");
                }
            }
        }
        if quiescent {
            ensure!(s["pending"].as_array().unwrap().is_empty() && res == 0, "P8 not quiescent");
        }
        Ok(())
    }
}

impl Out {
    fn ok(self) -> Result<Value> {
        match self {
            Out::Ok(v) => Ok(v),
            other => bail!("expected success, got {}", other.status()),
        }
    }
}

macro_rules! expect_status {
    ($out:expr, $want:expr) => {{
        let o = $out;
        let got = o.status();
        ensure!(got == $want, "expected {} got {} ({:?})", $want, got, o);
    }};
}

// ---------- scenarios ----------

type Fut<'a> = Pin<Box<dyn Future<Output = Result<String>> + 'a>>;

/// T-01: one payment, events, merchant credited.
async fn t01(w: &Worker<Sandbox>) -> Result<String> {
    let env = Env::new(w, "t01", Cfg::default()).await?;
    let id = pid("t01", 1);
    let deadline = env.now_ms().await? + 120_000;
    let res = env
        .agent(1)
        .acct
        .call(&env.vault, "pay")
        .args_json(json!({"payment_id": id, "merchant": env.m1.id(), "amount": "50000", "deadline_ms": deadline}))
        .gas(PAY_GAS)
        .transact()
        .await?;
    let logs: Vec<String> = res.logs().iter().map(|s| s.to_string()).collect();
    let tx = res.outcome().transaction_hash;
    let v: Value = res.into_result()?.json()?;
    ensure!(v["status"] == "paid" && v["payment_id"] == id, "PayResult {v}");
    ensure!(logs.iter().any(|l| l.contains("\"payment_reserved\"") && l.contains(&id)), "payment_reserved event");
    ensure!(logs.iter().any(|l| l.contains("\"payment_paid\"") && l.contains(&id)), "payment_paid event");
    ensure!(env.ft_balance(env.m1.id()).await? == 50_000, "merchant credited");
    let p: Value = env.w.view(&env.vault, "payment").args_json(json!({"payment_id": id})).await?.json()?;
    ensure!(p["status"] == "paid", "payment view {p}");
    env.check(true).await?;
    Ok(format!("tx {tx}: PayResult paid seq {}; merchant +50000", v["seq"]))
}

/// T-02, T-16: duplicate payment_id, and re-broadcast of identical signed bytes.
async fn t02_t16(w: &Worker<Sandbox>) -> Result<String> {
    use near_jsonrpc_client::methods::broadcast_tx_commit::RpcBroadcastTxCommitRequest;
    let env = Env::new(w, "t02", Cfg::default()).await?;
    let id = pid("t02", 1);
    expect_status!(env.pay(1, &id, env.m1.id(), 50_000).await?, "paid");
    expect_status!(env.pay(1, &id, env.m1.id(), 50_000).await?, "rejected:duplicate_payment");
    expect_status!(env.pay(2, &id, env.m1.id(), 50_000).await?, "rejected:duplicate_payment");
    ensure!(env.w.view(&env.vault, "payment").args_json(json!({"payment_id": id})).await?.json::<Value>()?["status"] == "paid");

    // T-16: sign one pay tx for agent 3 by hand and broadcast the identical bytes twice.
    let a3 = env.agent(3);
    let ak = env.w.view_access_key(&env.vault, &a3.sk.public_key()).await?;
    let id16 = pid("t16", 1);
    let args = json!({"payment_id": id16, "merchant": env.m1.id(), "amount": "20000",
                      "deadline_ms": env.now_ms().await? + 120_000});
    let stx = env.sign_raw(&a3.sk, ak.nonce + 1, "pay", &args).await?;
    let hash = stx.get_hash();
    let client = near_jsonrpc_client::JsonRpcClient::connect(env.w.rpc_addr());
    let first = client.call(RpcBroadcastTxCommitRequest { signed_transaction: stx.clone() }).await;
    let first = first.map_err(|e| anyhow!("first broadcast failed: {e:?}"))?;
    let before = env.state().await?;
    let m1_before = env.ft_balance(env.m1.id()).await?;
    let mut second_results = vec![];
    for _ in 0..2 {
        let r = client.call(RpcBroadcastTxCommitRequest { signed_transaction: stx.clone() }).await;
        second_results.push(match r {
            Ok(o) => {
                ensure!(o.transaction.hash == first.transaction.hash, "rebroadcast returned a different tx");
                "same outcome returned".to_string()
            }
            Err(e) => short_err(&format!("{e:?}")),
        });
    }
    let after = env.state().await?;
    ensure!(before["counts"] == after["counts"], "counters changed on rebroadcast");
    ensure!(env.ft_balance(env.m1.id()).await? == m1_before, "merchant changed on rebroadcast");
    ensure!(before["paid_total"] == after["paid_total"]);
    env.check(true).await?;
    Ok(format!("dup id rejected twice (same agent, other agent); T-16 tx {hash}: rebroadcasts -> {second_results:?}, state unchanged"))
}

/// T-13: 20 concurrent $0.05 pays from one agent against $0.25/day: exactly 5 paid.
async fn t13(w: &Worker<Sandbox>) -> Result<String> {
    // Burst agent with the 3 NEAR allowance cap: allowance bounds how many txs one key can have in flight.
    let mut env = Env::new(w, "t13", Cfg { agents: 0, ..Cfg::default() }).await?;
    let id = env.register_with("burst", 100_000, 250_000, 3 * AGENT_ALLOWANCE).await?;
    burst(&env, &[(id, 20)], 250_000, 1_000_000, 5, "over_agent_daily_limit").await
}

/// S-1(e): how many concurrent pay txs one FC key with a 1 NEAR allowance can have in flight.
/// Txs beyond that are dropped before inclusion (never executed): no state change.
async fn s1e_allowance(w: &Worker<Sandbox>) -> Result<String> {
    let env = Env::new(w, "s1e", Cfg { agents: 1, daily: 10_000_000, per_payment: 10_000, org: 10_000_000, ..Cfg::default() }).await?;
    let pk = env.agent(1).sk.public_key();
    let base = env.w.view_access_key(&env.vault, &pk).await?.nonce;
    let gas_price = env.w.view_block().await?.header().gas_price().as_yoctonear();
    let deadline = env.now_ms().await? + 120_000;
    let mut st = vec![];
    for i in 0..20 {
        st.push(
            env.agent(1)
                .acct
                .call(&env.vault, "pay")
                .args_json(json!({"payment_id": pid("s1e", i), "merchant": env.m1.id(), "amount": "10000", "deadline_ms": deadline}))
                .gas(PAY_GAS)
                .transact_async()
                .await?,
        );
    }
    // Wait for the nonce to stop moving.
    let mut last = base;
    let mut stable = 0;
    while stable < 15 {
        tokio::time::sleep(Duration::from_millis(400)).await;
        let n = env.w.view_access_key(&env.vault, &pk).await?.nonce;
        if n == last { stable += 1 } else { stable = 0; last = n }
    }
    let landed = last - base;
    let s = env.state().await?;
    ensure!(s["counts"]["paid"].as_u64() == Some(landed), "paid count {} != landed {landed}", s["counts"]["paid"]);
    env.check(true).await?;
    drop(st);
    Ok(format!("1 NEAR allowance, 60 Tgas pays, gas price {gas_price} yocto/gas: {landed} of 20 concurrent txs executed, the rest dropped before inclusion (no receipt, no state change)"))
}

/// T-14: 40 concurrent pays across 4 agents (daily 1.00 each) against org 0.50: exactly 10 paid.
async fn t14(w: &Worker<Sandbox>) -> Result<String> {
    let env = Env::new(w, "t14", Cfg { daily: 1_000_000, org: 500_000, ..Cfg::default() }).await?;
    burst(&env, &[(1, 10), (2, 10), (3, 10), (4, 10)], 1_000_000, 500_000, 10, "over_org_daily_limit").await
}

/// T-15: agent and org limits together: daily 0.25 each, org 0.60: exactly 12 paid, each agent at most 5.
async fn t15(w: &Worker<Sandbox>) -> Result<String> {
    let env = Env::new(w, "t15", Cfg { org: 600_000, ..Cfg::default() }).await?;
    burst(&env, &[(1, 10), (2, 10), (3, 10), (4, 10)], 250_000, 600_000, 12, "").await
}

async fn burst(env: &Env, plan: &[(u32, u64)], daily: u128, org: u128, want_paid: usize, want_reason: &str) -> Result<String> {
    let deadline = env.now_ms().await? + 300_000;
    let mut statuses = vec![];
    // Interleave agents; each agent's txs are signed with consecutive nonces and sent async.
    let max = plan.iter().map(|p| p.1).max().unwrap();
    let t0 = Instant::now();
    for i in 0..max {
        for &(agent, count) in plan {
            if i < count {
                let id = pid(&format!("{}-burst-{agent}", env.vault), i);
                let st = env
                    .agent(agent)
                    .acct
                    .call(&env.vault, "pay")
                    .args_json(json!({"payment_id": id, "merchant": env.m1.id(), "amount": "50000", "deadline_ms": deadline}))
                    .gas(PAY_GAS)
                    .transact_async()
                    .await
                    .with_context(|| format!("broadcast_tx_async agent {agent} tx {i} after {} ms", t0.elapsed().as_millis()))?;
                statuses.push((agent, st));
            }
        }
    }
    let submit_ms = t0.elapsed().as_millis();
    // Poll state while in flight: no agent or org exposure may ever exceed its limit.
    let mut results: Vec<Option<(u32, ExecutionFinalResult)>> = statuses.iter().map(|_| None).collect();
    let mut polls = 0;
    let deadline_wait = Instant::now() + Duration::from_secs(120);
    while results.iter().any(|r| r.is_none()) {
        ensure!(Instant::now() < deadline_wait, "burst did not finish in 120 s");
        let s = env.state().await?;
        polls += 1;
        let n = |v: &Value| -> u128 { v.as_str().unwrap().parse().unwrap() };
        for a in s["agents"].as_array().unwrap() {
            ensure!(n(&a["spent_today"]) + n(&a["reserved"]) <= daily, "agent exposure above daily limit: {a}");
        }
        ensure!(n(&s["org"]["spent_today"]) + n(&s["org"]["reserved"]) <= org, "org exposure above limit");
        for (i, (agent, st)) in statuses.iter().enumerate() {
            if results[i].is_none() {
                match st.status().await {
                    Ok(std::task::Poll::Ready(r)) => results[i] = Some((*agent, r)),
                    Ok(_) => {}
                    Err(e) => {
                        let ak = env.w.view_access_key(&env.vault, &env.agent(*agent).sk.public_key()).await;
                        bail!("tx {i} (agent {agent}, hash {}) not resolved: {e:?}; key now {ak:?}", st.hash())
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    // Tally, and find receipt blocks: all pay receipts vs the first settlement callback.
    let mut paid_by_agent: BTreeMap<u32, usize> = BTreeMap::new();
    let mut reasons: BTreeMap<String, usize> = BTreeMap::new();
    let mut pay_blocks = vec![];
    let mut settle_blocks = vec![];
    for (agent, r) in results.into_iter().flatten() {
        let outs: Vec<_> = r.outcomes().into_iter().cloned().collect();
        // outcomes()[0] is the tx, [1] the pay receipt; a settlement callback logs payment_paid/failed.
        if let Some(pay) = outs.get(1) {
            pay_blocks.push(pay.block_hash);
        }
        for o in &outs {
            if o.executor_id == env.vault && o.logs.iter().any(|l| l.contains("\"payment_paid\"") || l.contains("\"payment_failed\"")) {
                settle_blocks.push(o.block_hash);
            }
        }
        if r.is_failure() {
            bail!("pay receipt failed: {:?}", r.into_result().unwrap_err());
        }
        let v: Value = r.json()?;
        match v["status"].as_str().unwrap() {
            "paid" => *paid_by_agent.entry(agent).or_default() += 1,
            "rejected" => *reasons.entry(v["reason"].as_str().unwrap().to_string()).or_default() += 1,
            other => bail!("unexpected status {other}"),
        }
    }
    let height = |h: near_workspaces::types::CryptoHash| async move {
        env.w.view_block().block_hash(h).await.map(|b| b.height())
    };
    let mut max_pay = 0;
    for h in pay_blocks {
        max_pay = max_pay.max(height(h).await?);
    }
    let mut min_settle = u64::MAX;
    for h in settle_blocks {
        min_settle = min_settle.min(height(h).await?);
    }
    let paid: usize = paid_by_agent.values().sum();
    let total = statuses.len();
    ensure!(paid == want_paid, "paid {paid} != {want_paid} ({paid_by_agent:?}, {reasons:?})");
    if !want_reason.is_empty() {
        ensure!(reasons.get(want_reason) == Some(&(total - want_paid)), "reasons {reasons:?}");
    } else {
        ensure!(
            reasons.keys().all(|r| r == "over_agent_daily_limit" || r == "over_org_daily_limit"),
            "reasons {reasons:?}"
        );
        ensure!(paid_by_agent.values().all(|&c| c <= 5), "an agent paid more than 5");
    }
    let s = env.state().await?;
    let spent: u128 = s["agents"].as_array().unwrap().iter().map(|a| a["spent_today"].as_str().unwrap().parse::<u128>().unwrap()).sum();
    ensure!(spent == want_paid as u128 * 50_000, "sum spent_today {spent}");
    ensure!(s["counts"]["next_seq"].as_u64() == Some(total as u64), "next_seq");
    ensure!(env.ft_balance(env.m1.id()).await? == want_paid as u128 * 50_000, "merchant received");
    env.check(true).await?;
    let ordering = if max_pay < min_settle {
        format!("all {total} pay receipts by block {max_pay}, first settlement at block {min_settle}")
    } else {
        format!("pay receipts up to block {max_pay}, first settlement at block {min_settle} (overlap)")
    };
    Ok(format!(
        "{total} async txs submitted in {submit_ms} ms; {paid} paid {paid_by_agent:?}, rejected {reasons:?}; {ordering}; {polls} in-flight polls within limits"
    ))
}

/// T-04, T-05, T-19: pause and resume.
async fn t05_pause(w: &Worker<Sandbox>) -> Result<String> {
    let env = Env::new(w, "t05", Cfg::default()).await?;
    let g = classify(env.guardian.call(&env.vault, "pause_agent").args_json(json!({"agent_id": 1})).transact().await);
    expect_status!(g.clone(), "null");
    expect_status!(env.pay(1, &pid("t05", 1), env.m1.id(), 50_000).await?, "rejected:agent_paused");
    expect_status!(env.pay(2, &pid("t05", 2), env.m1.id(), 50_000).await?, "paid");
    classify(env.guardian.call(&env.vault, "pause_all").transact().await).ok()?;
    expect_status!(env.pay(2, &pid("t05", 3), env.m1.id(), 50_000).await?, "rejected:org_paused");
    let s = env.state().await?;
    ensure!(s["agents"].as_array().unwrap().iter().all(|a| a["remaining_today"] == "0"), "remaining 0 while paused");
    env.owner_call("resume_all", json!({})).await?.ok()?;
    expect_status!(env.pay(1, &pid("t05", 1), env.m1.id(), 50_000).await?, "rejected:agent_paused");
    expect_status!(env.pay(2, &pid("t05", 3), env.m1.id(), 50_000).await?, "paid");
    env.owner_call("resume_agent", json!({"agent_id": 1})).await?.ok()?;
    expect_status!(env.pay(1, &pid("t05", 1), env.m1.id(), 50_000).await?, "paid");
    env.check(true).await?;
    Ok("guardian pause_agent: a1 agent_paused, a2 paid; pause_all: org_paused; resume_all keeps agent pause; resume_agent: retried id paid".into())
}

/// T-06: non-allowlisted merchant.
async fn t06(w: &Worker<Sandbox>) -> Result<String> {
    let env = Env::new(w, "t06", Cfg::default()).await?;
    expect_status!(env.pay(1, &pid("t06", 1), env.m2.id(), 50_000).await?, "rejected:merchant_not_allowed");
    ensure!(env.ft_balance(env.m2.id()).await? == 0, "m2 unchanged");
    let p: Value = env.w.view(&env.vault, "payment").args_json(json!({"payment_id": pid("t06", 1)})).await?.json()?;
    ensure!(p.is_null(), "rejected id not stored");
    env.check(true).await?;
    Ok("merchant_not_allowed, m2 balance 0, payment(id) null".into())
}

/// T-07, T-08, T-09, T-10 on chain.
async fn t07_t10(w: &Worker<Sandbox>) -> Result<String> {
    let env = Env::new(w, "t07", Cfg { org: 300_000, deposit: 350_000, ..Cfg::default() }).await?;
    let m = env.m1.id();
    expect_status!(env.pay(1, &pid("t07", 1), m, 100_000).await?, "paid");
    expect_status!(env.pay(1, &pid("t07", 2), m, 100_001).await?, "rejected:over_per_payment_limit");
    expect_status!(env.pay(1, &pid("t07", 3), m, 100_000).await?, "paid");
    expect_status!(env.pay(1, &pid("t07", 4), m, 100_000).await?, "rejected:over_agent_daily_limit");
    expect_status!(env.pay(1, &pid("t07", 5), m, 50_000).await?, "paid");
    ensure!(Env::agent_state(&env.state().await?, 1)["remaining_today"] == "0");
    expect_status!(env.pay(2, &pid("t07", 6), m, 100_000).await?, "rejected:over_org_daily_limit");
    expect_status!(env.pay(2, &pid("t07", 7), m, 50_000).await?, "paid");
    ensure!(env.state().await?["org"]["spent_today"] == "300000");
    env.owner_call("set_org_daily_limit", json!({"limit": "1000000"})).await?.ok()?;
    expect_status!(env.pay(2, &pid("t07", 8), m, 100_000).await?, "rejected:insufficient_vault_balance");
    env.check(true).await?;
    Ok("per-payment, agent daily, org daily and vault balance rejections in order; remaining_today 0".into())
}

/// T-25, T-26: failed transfers refund available and both headrooms exactly.
async fn t25_t26(w: &Worker<Sandbox>) -> Result<String> {
    let env = Env::new(w, "t25", Cfg::default()).await?;
    let before = env.state().await?;
    let a_before = Env::agent_state(&before, 1).clone();
    let id = pid("t25", 1);
    expect_status!(env.pay(1, &id, env.m3.id(), 50_000).await?, "failed:transfer_failed");
    let after = env.state().await?;
    let a_after = Env::agent_state(&after, 1);
    ensure!(after["available"] == before["available"], "available restored");
    ensure!(after["org"]["spent_today"] == "0" && after["org"]["reserved"] == "0", "org headroom restored");
    ensure!(a_after["remaining_today"] == a_before["remaining_today"] && a_after["spent_today"] == "0", "agent headroom restored");
    ensure!(a_after["failed_count"] == 1 && after["counts"]["failed"] == 1);
    let p: Value = env.w.view(&env.vault, "payment").args_json(json!({"payment_id": id})).await?.json()?;
    ensure!(p["status"] == "failed");
    // T-26: token panics on a registered merchant.
    env.owner.call(&env.ft, "set_fail_transfers").args_json(json!({"fail": true})).transact().await?.into_result()?;
    expect_status!(env.pay(1, &pid("t26", 1), env.m1.id(), 50_000).await?, "failed:transfer_failed");
    env.owner.call(&env.ft, "set_fail_transfers").args_json(json!({"fail": false})).transact().await?.into_result()?;
    ensure!(env.ft_balance(env.m1.id()).await? == 0);
    // Headroom is fully usable after the refunds.
    expect_status!(env.pay(1, &pid("t26", 2), env.m1.id(), 100_000).await?, "paid");
    expect_status!(env.pay(1, &pid("t26", 3), env.m1.id(), 100_000).await?, "paid");
    expect_status!(env.pay(1, &pid("t26", 4), env.m1.id(), 50_000).await?, "paid");
    env.check(true).await?;
    Ok("unregistered receiver and token panic both settle failed:transfer_failed with exact refunds; full 250000 headroom then usable".into())
}

const ADMIN_METHODS: &[&str] = &[
    "on_payment_settled", "on_withdraw_settled", "on_guardian_rotated", "migrate", "new", "ft_on_transfer",
    "pause_agent", "pause_all", "register_agent", "rotate_guardian", "withdraw", "upgrade", "resume_all", "remove_merchant",
    "resume_agent", "revoke_agent", "set_agent_limits", "set_org_daily_limit", "add_merchant", "refill_agent_key",
];

/// T-21: an agent key can call nothing but pay, cannot attach deposit, cannot batch.
async fn t21(w: &Worker<Sandbox>) -> Result<String> {
    let env = Env::new(w, "t21", Cfg::default()).await?;
    let before = env.state().await?;
    let a = &env.agent(1).acct;
    let mut refused = 0;
    for m in ADMIN_METHODS {
        let o = classify(a.call(&env.vault, m).args_json(json!({})).gas(Gas::from_tgas(60)).transact().await);
        ensure!(o.status() == "proto:MethodNameMismatch", "agent key {m}: {}", o.status());
        refused += 1;
    }
    let dep = classify(
        a.call(&env.vault, "pay")
            .args_json(json!({"payment_id": pid("t21", 1), "merchant": env.m1.id(), "amount": "1000", "deadline_ms": env.now_ms().await? + 60_000}))
            .deposit(ONE_YOCTO)
            .gas(PAY_GAS)
            .transact()
            .await,
    );
    ensure!(matches!(dep, Out::Proto(_)), "pay with deposit not refused by protocol: {}", dep.status());
    let two = classify(
        a.batch(&env.vault)
            .call(Function::new("pay").args_json(json!({})).gas(Gas::from_tgas(60)))
            .call(Function::new("pay").args_json(json!({})).gas(Gas::from_tgas(60)))
            .transact()
            .await,
    );
    ensure!(matches!(two, Out::Proto(_)), "two-action tx not refused: {}", two.status());
    // Another receiver.
    let other = classify(a.call(&env.ft, "ft_transfer").args_json(json!({})).gas(Gas::from_tgas(30)).transact().await);
    ensure!(matches!(other, Out::Proto(_)), "agent key reached another receiver: {}", other.status());
    ensure!(env.state().await?["counts"] == before["counts"]);
    env.check(true).await?;
    Ok(format!(
        "{refused} admin/callback methods MethodNameMismatch; deposit {}; two actions {}; other receiver {}",
        dep.status(),
        two.status(),
        other.status()
    ))
}

/// T-22: guardian key only pauses.
async fn t22(w: &Worker<Sandbox>) -> Result<String> {
    let env = Env::new(w, "t22", Cfg::default()).await?;
    let mut refused = 0;
    for m in ADMIN_METHODS.iter().filter(|m| **m != "pause_agent" && **m != "pause_all").chain(["pay"].iter()) {
        let o = classify(env.guardian.call(&env.vault, m).args_json(json!({})).gas(Gas::from_tgas(60)).transact().await);
        ensure!(o.status() == "proto:MethodNameMismatch", "guardian {m}: {}", o.status());
        refused += 1;
    }
    for _ in 0..2 {
        classify(env.guardian.call(&env.vault, "pause_agent").args_json(json!({"agent_id": 1})).transact().await).ok()?;
    }
    ensure!(Env::agent_state(&env.state().await?, 1)["status"] == "paused");
    env.check(true).await?;
    Ok(format!("{refused} methods MethodNameMismatch (incl. withdraw, resume, register, upgrade, set limits); pause_agent twice ok"))
}

/// T-24, T-17: outsider and owner-without-yocto refused; pay panics before any state change.
async fn t17_t24(w: &Worker<Sandbox>) -> Result<String> {
    let env = Env::new(w, "t24", Cfg::default()).await?;
    let before = env.state().await?;
    let calls: Vec<(&str, Value)> = vec![
        ("register_agent", json!({"name": "x", "public_key": SecretKey::from_random(KeyType::ED25519).public_key(), "per_payment_limit": "1", "daily_limit": "2", "allowance": "1"})),
        ("set_agent_limits", json!({"agent_id": 1, "per_payment_limit": "1", "daily_limit": "2"})),
        ("set_org_daily_limit", json!({"limit": "1"})),
        ("resume_all", json!({})),
        ("revoke_agent", json!({"agent_id": 1})),
        ("refill_agent_key", json!({"agent_id": 1, "allowance": "1"})),
        ("add_merchant", json!({"account": env.m2.id(), "name": "x"})),
        ("remove_merchant", json!({"account": env.m1.id()})),
        ("withdraw", json!({"amount": "1"})),
        ("rotate_guardian", json!({"new_pk": SecretKey::from_random(KeyType::ED25519).public_key()})),
        ("pause_agent", json!({"agent_id": 1})),
        ("pause_all", json!({})),
    ];
    for (m, args) in &calls {
        let o = classify(env.outsider.call(&env.vault, m).args_json(args).deposit(ONE_YOCTO).gas(Gas::from_tgas(50)).transact().await);
        ensure!(o.status() == "panic:E_AUTH", "outsider {m}: {}", o.status());
    }
    let up = classify(env.outsider.call(&env.vault, "upgrade").args(wasm("orbit_vault")).deposit(ONE_YOCTO).max_gas().transact().await);
    ensure!(up.status() == "panic:E_AUTH", "outsider upgrade: {}", up.status());
    let no_yocto = classify(env.owner.call(&env.vault, "set_org_daily_limit").args_json(json!({"limit": "1"})).transact().await);
    ensure!(no_yocto.status() == "panic:E_DEPOSIT", "owner without yocto: {}", no_yocto.status());
    // T-17 on chain.
    let o = classify(
        env.outsider
            .call(&env.vault, "pay")
            .args_json(json!({"payment_id": pid("t17", 1), "merchant": env.m1.id(), "amount": "50000", "deadline_ms": env.now_ms().await? + 60_000}))
            .gas(PAY_GAS)
            .transact()
            .await,
    );
    ensure!(o.status() == "panic:E_AUTH", "outsider pay: {}", o.status());
    let deadline = env.now_ms().await? + 60_000;
    let low_gas = classify(
        env.agent(1)
            .acct
            .call(&env.vault, "pay")
            .args_json(json!({"payment_id": pid("t17", 2), "merchant": env.m1.id(), "amount": "50000", "deadline_ms": deadline}))
            .gas(Gas::from_tgas(59))
            .transact()
            .await,
    );
    ensure!(low_gas.status() == "panic:E_GAS", "59 Tgas: {}", low_gas.status());
    let bad_id = env.pay(1, &pid("t17", 3)[1..], env.m1.id(), 50_000).await?;
    ensure!(bad_id.status() == "panic:E_ARGS", "63-char id: {}", bad_id.status());
    let small = env.pay(1, &pid("t17", 4), env.m1.id(), 999).await?;
    ensure!(small.status() == "panic:E_ARGS", "999: {}", small.status());
    let after = env.state().await?;
    ensure!(before["counts"] == after["counts"] && before["org"] == after["org"], "state changed");
    env.check(true).await?;
    Ok(format!("outsider: {} methods + upgrade E_AUTH; owner without yocto E_DEPOSIT; pay: E_AUTH, E_GAS, E_ARGS x2, no ring entry", calls.len()))
}

/// T-20, T-32: revoke removes the key; key permissions; refill keeps ["pay"].
async fn t20_t32(w: &Worker<Sandbox>) -> Result<String> {
    let mut env = Env::new(w, "t20", Cfg::default()).await?;
    let keys = env.w.view_access_keys(&env.vault).await?;
    let a1_pk = env.agent(1).sk.public_key();
    let perm = keys.iter().find(|k| k.public_key == a1_pk).map(|k| format!("{:?}", k.access_key.permission));
    env.owner_call("revoke_agent", json!({"agent_id": 1})).await?.ok()?;
    env.revoked.insert(1);
    let args = json!({"payment_id": pid("t20", 1), "merchant": env.m1.id(), "amount": "50000", "deadline_ms": env.now_ms().await? + 60_000});
    let stx = env.sign_raw(&env.agent(1).sk, 1_000_000_000_000, "pay", &args).await?;
    let o = env.broadcast_raw(&stx).await?;
    ensure!(matches!(&o, Err(e) if e.contains("AccessKeyNotFound")), "revoked pay: {o:?}");
    let re = env
        .owner_call(
            "register_agent",
            json!({"name": "again", "public_key": a1_pk, "per_payment_limit": "1", "daily_limit": "2", "allowance": "1"}),
        )
        .await?;
    ensure!(re.status() == "panic:E_ARGS", "re-register revoked pk: {}", re.status());
    let g = classify(env.guardian.call(&env.vault, "pause_agent").args_json(json!({"agent_id": 1})).transact().await);
    ensure!(g.status() == "panic:E_STATE", "pause revoked: {}", g.status());
    // Bad registrations.
    let gpk = env.guardian_sk.public_key();
    for args in [
        json!({"name": "g", "public_key": gpk, "per_payment_limit": "1", "daily_limit": "2", "allowance": "1"}),
        json!({"name": "x", "public_key": env.agent(2).sk.public_key(), "per_payment_limit": "1", "daily_limit": "2", "allowance": "1"}),
        json!({"name": "x", "public_key": SecretKey::from_random(KeyType::ED25519).public_key(), "per_payment_limit": "3", "daily_limit": "2", "allowance": "1"}),
        json!({"name": "a".repeat(33), "public_key": SecretKey::from_random(KeyType::ED25519).public_key(), "per_payment_limit": "1", "daily_limit": "2", "allowance": "1"}),
        json!({"name": "x", "public_key": SecretKey::from_random(KeyType::ED25519).public_key(), "per_payment_limit": "1", "daily_limit": "2", "allowance": "3000000000000000000000001"}),
        json!({"name": "x", "public_key": SecretKey::from_random(KeyType::ED25519).public_key(), "per_payment_limit": "1", "daily_limit": "2", "allowance": "0"}),
    ] {
        let o = env.owner_call("register_agent", args).await?;
        ensure!(o.status() == "panic:E_ARGS", "bad register: {}", o.status());
    }
    // Refill: same key, new allowance, still ["pay"].
    let a5 = env.register("a5", 100_000, 250_000).await?;
    env.owner_call("refill_agent_key", json!({"agent_id": a5, "allowance": "500000000000000000000000"})).await?.ok()?;
    env.allowances.insert(a5, 500_000_000_000_000_000_000_000);
    let k = env.w.view_access_key(&env.vault, &env.agent(a5).sk.public_key()).await?;
    let refill = format!("{:?}", k.permission);
    expect_status!(env.pay(a5, &pid("t20", 5), env.m1.id(), 50_000).await?, "paid");
    env.check(true).await?;
    Ok(format!("a1 key before revoke {}; revoked pay AccessKeyNotFound; 7 bad registers E_ARGS/E_STATE; refill -> {}", perm.unwrap_or_default(), refill))
}

/// T-27, T-28, T-31: deposit clamp, outsider deposit refund, withdraw.
async fn t27_t31(w: &Worker<Sandbox>) -> Result<String> {
    let env = Env::new(w, "t27", Cfg { deposit: 1_000_000, ..Cfg::default() }).await?;
    let owner_before = env.ft_balance(env.owner.id()).await?;
    let used = env.mint_and_deposit(25_000_000).await?; // ft_transfer_call returns the used amount
    let s = env.state().await?;
    ensure!(s["available"] == "20000000", "clamped to float cap: {}", s["available"]);
    ensure!(used == "19000000", "used {used}");
    ensure!(env.ft_balance(env.owner.id()).await? == owner_before + 6_000_000, "owner refunded excess");
    // Outsider deposit refused and refunded.
    env.owner.call(&env.ft, "mint").args_json(json!({"account_id": env.outsider.id(), "amount": "1000000"})).transact().await?.into_result()?;
    let r = env
        .outsider
        .call(&env.ft, "ft_transfer_call")
        .args_json(json!({"receiver_id": env.vault, "amount": "1000000", "msg": ""}))
        .deposit(ONE_YOCTO)
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    let logs: Vec<String> = r.logs().iter().map(|s| s.to_string()).collect();
    ensure!(r.into_result()?.json::<String>()? == "0", "outsider deposit used nothing");
    ensure!(logs.iter().any(|l| l.contains("deposit_refused")));
    ensure!(env.ft_balance(env.outsider.id()).await? == 1_000_000, "outsider refunded");
    // Withdraw.
    let o = env.owner_call("withdraw", json!({"amount": "20000001"})).await?;
    ensure!(o.status() == "panic:E_FUNDS", "withdraw above available: {}", o.status());
    let ob = env.ft_balance(env.owner.id()).await?;
    env.owner_call("withdraw", json!({"amount": "1000000"})).await?.ok()?;
    let s = env.state().await?;
    ensure!(s["withdrawn_total"] == "1000000" && s["available"] == "19000000");
    ensure!(env.ft_balance(env.owner.id()).await? == ob + 1_000_000);
    env.check(true).await?;
    Ok("deposit 25 USDC clamped to 20 (6 refunded incl. prior top-up), outsider deposit refunded with deposit_refused, withdraw E_FUNDS then 1 USDC".into())
}

/// T-35 (partial): owner-only upgrade with migrate in the same batch.
async fn t35(w: &Worker<Sandbox>) -> Result<String> {
    let env = Env::new(w, "t35", Cfg::default()).await?;
    expect_status!(env.pay(1, &pid("t35", 1), env.m1.id(), 50_000).await?, "paid");
    let before = env.state().await?;
    let g = classify(env.guardian.call(&env.vault, "upgrade").args(wasm("orbit_vault")).max_gas().transact().await);
    ensure!(g.status() == "proto:MethodNameMismatch", "guardian upgrade: {}", g.status());
    let r = env.owner.call(&env.vault, "upgrade").args(wasm("orbit_vault")).deposit(ONE_YOCTO).max_gas().transact().await?;
    let logs: Vec<String> = r.logs().iter().map(|s| s.to_string()).collect();
    let tx = r.outcome().transaction_hash;
    r.into_result()?;
    ensure!(logs.iter().any(|l| l.contains("\"upgraded\"")), "upgraded event: {logs:?}");
    let after = env.state().await?;
    for k in ["available", "paid_total", "counts", "agents", "merchants", "org"] {
        ensure!(before[k] == after[k], "state {k} changed across upgrade");
    }
    expect_status!(env.pay(1, &pid("t35", 2), env.m1.id(), 50_000).await?, "paid");
    let code = format!("{:?}", env.w.view_account(&env.vault).await?.contract_state);
    env.check(true).await?;
    Ok(format!("guardian MethodNameMismatch; owner upgrade tx {tx} emitted upgraded, state preserved, pay works after; code_hash {code}"))
}

/// T-52: guardian rotation.
async fn t52(w: &Worker<Sandbox>) -> Result<String> {
    let env = Env::new(w, "t52", Cfg::default()).await?;
    let new_sk = SecretKey::from_random(KeyType::ED25519);
    let r = env.owner_call("rotate_guardian", json!({"new_pk": new_sk.public_key()})).await?;
    ensure!(r.status() == "true", "rotate: {}", r.status());
    let stx = env.sign_raw(&env.guardian_sk, 1_000_000_000_000, "pause_all", &json!({})).await?;
    let old = env.broadcast_raw(&stx).await?;
    ensure!(matches!(&old, Err(e) if e.contains("AccessKeyNotFound")), "old guardian: {old:?}");
    let newg = Account::from_secret_key(env.vault.clone(), new_sk.clone(), w);
    classify(newg.call(&env.vault, "pause_agent").args_json(json!({"agent_id": 1})).transact().await).ok()?;
    let a2 = env.owner_call("rotate_guardian", json!({"new_pk": env.agent(2).sk.public_key()})).await?;
    ensure!(a2.status() == "panic:E_ARGS", "rotate to agent pk: {}", a2.status());
    let same = env.owner_call("rotate_guardian", json!({"new_pk": new_sk.public_key()})).await?;
    ensure!(same.status() == "panic:E_ARGS", "rotate to same: {}", same.status());
    ensure!(env.state().await?["guardian_pk"] == json!(new_sk.public_key()));
    env.check(true).await?;
    Ok("rotated; old key AccessKeyNotFound; new key pauses; agent pk and current pk E_ARGS".into())
}

/// T-39 (partial): ring wrap, rejections storage-neutral, gas used by pay and the callback.
async fn t39(w: &Worker<Sandbox>) -> Result<String> {
    let mut env = Env::new(w, "t39", Cfg { agents: 1, ..Cfg::default() }).await?;
    env.register_with("flood", 100_000, 250_000, 3 * AGENT_ALLOWANCE).await?;
    let id = pid("t39", 0);
    let deadline = env.now_ms().await? + 120_000;
    let r = env
        .agent(1)
        .acct
        .call(&env.vault, "pay")
        .args_json(json!({"payment_id": id, "merchant": env.m1.id(), "amount": "50000", "deadline_ms": deadline}))
        .gas(PAY_GAS)
        .transact()
        .await?;
    let gas: Vec<(String, u64)> = r
        .outcomes()
        .iter()
        .skip(1)
        .map(|o| (o.executor_id.to_string(), o.gas_burnt.as_gas() / 1_000_000_000))
        .collect();
    r.into_result()?;
    // Warm one rejection, then 299 more: storage must not change.
    expect_status!(env.pay(2, &pid("t39", 1), env.m2.id(), 10_000).await?, "rejected:merchant_not_allowed");
    let su0 = env.state().await?["near"]["storage_usage"].as_u64().unwrap();
    let deadline = env.now_ms().await? + 300_000;
    for wave in 0..8u64 {
    let mut st = vec![];
    for i in (2 + wave * 40)..(2 + (wave + 1) * 40).min(300) {
        st.push(
            env.agent(2)
                .acct
                .call(&env.vault, "pay")
                .args_json(json!({"payment_id": pid("t39", i), "merchant": env.m2.id(), "amount": "10000", "deadline_ms": deadline}))
                .gas(PAY_GAS)
                .transact_async()
                .await?,
        );
    }
    for s in st {
        let r = s.await?;
        ensure!(r.json::<Value>()?["reason"] == "merchant_not_allowed");
    }
    }
    let s = env.state().await?;
    let su1 = s["near"]["storage_usage"].as_u64().unwrap();
    ensure!(su0 == su1, "storage changed across rejections: {su0} -> {su1}");
    ensure!(s["counts"]["next_seq"] == 300);
    let o = env.outcomes(0).await?;
    ensure!(o["oldest_seq"] == 44 && o["entries"][0]["seq"] == 44, "ring window {}", o["oldest_seq"]);
    env.check(true).await?;
    Ok(format!("pay receipts gas (Ggas): {gas:?}; 300 outcomes, oldest_seq 44, storage_usage unchanged at {su1} across 298 rejections"))
}

/// T-18, T-34, T-02(b), T-20 (pending part): with mock-ft delay hops, act between reservation and settlement.
async fn t18_t34(w: &Worker<Sandbox>) -> Result<String> {
    let env = Env::new(w, "t18", Cfg::default()).await?;
    env.owner.call(&env.ft, "set_delay_hops").args_json(json!({"hops": 8})).transact().await?.into_result()?;
    let envr = &env;
    let height = |h: near_workspaces::types::CryptoHash| async move { envr.w.view_block().block_hash(h).await.map(|b| b.height()) };
    let start_pending = |agent: u32, id: String| {
        let env = &env;
        async move {
            let deadline = env.now_ms().await? + 120_000;
            let st = env
                .agent(agent)
                .acct
                .call(&env.vault, "pay")
                .args_json(json!({"payment_id": id, "merchant": env.m1.id(), "amount": "50000", "deadline_ms": deadline}))
                .gas(Gas::from_tgas(300))
                .transact_async()
                .await?;
            let t = Instant::now();
            loop {
                let p: Value = env.w.view(&env.vault, "payment").args_json(json!({"payment_id": id})).await?.json()?;
                if p["status"] == "pending" {
                    break;
                }
                ensure!(p.is_null(), "payment settled before the test could act: {p}");
                ensure!(t.elapsed() < Duration::from_secs(30), "payment never became pending");
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Ok::<_, anyhow::Error>(st)
        }
    };
    let paid_block = |r: &ExecutionFinalResult| r.outcomes().iter().find(|o| o.logs.iter().any(|l| l.contains("\"payment_paid\""))).map(|o| o.block_hash);

    // T-18: pause lands while a1's payment is in flight; the payment still settles, the next one is refused.
    let st = start_pending(1, pid("t18", 1)).await?;
    let pause = env.guardian.call(&env.vault, "pause_agent").args_json(json!({"agent_id": 1})).transact().await?;
    let pause_block = height(pause.outcome().block_hash).await?;
    pause.into_result()?;
    let r = st.await?;
    let pb = height(paid_block(&r).ok_or_else(|| anyhow!("no payment_paid event"))?).await?;
    ensure!(r.json::<Value>()?["status"] == "paid", "in-flight payment did not settle paid");
    ensure!(pause_block < pb, "pause block {pause_block} not before payment_paid block {pb}");
    expect_status!(env.pay(1, &pid("t18", 2), env.m1.id(), 50_000).await?, "rejected:agent_paused");

    // T-34 + T-02(b): merchant removed while a2's payment is in flight; the pending id is already a duplicate.
    let id = pid("t34", 1);
    let st = start_pending(2, id.clone()).await?;
    let dup = env.pay(3, &id, env.m1.id(), 50_000).await?;
    env.owner_call("remove_merchant", json!({"account": env.m1.id()})).await?.ok()?;
    let r = st.await?;
    ensure!(r.json::<Value>()?["status"] == "paid", "in-flight payment to a removed merchant did not settle");
    ensure!(dup.status() == "rejected:duplicate_payment", "pending id reused: {}", dup.status());
    expect_status!(env.pay(2, &pid("t34", 2), env.m1.id(), 50_000).await?, "rejected:merchant_not_allowed");
    env.owner_call("add_merchant", json!({"account": env.m1.id(), "name": "Orbit Data"})).await?.ok()?;

    // T-20 (pending part): revoke while a4's payment is in flight; it still settles.
    let st = start_pending(4, pid("t20p", 1)).await?;
    env.owner_call("revoke_agent", json!({"agent_id": 4})).await?.ok()?;
    let r = st.await?;
    ensure!(r.json::<Value>()?["status"] == "paid", "in-flight payment of a revoked agent did not settle");
    env.owner.call(&env.ft, "set_delay_hops").args_json(json!({"hops": 0})).transact().await?.into_result()?;
    ensure!(env.ft_balance(env.m1.id()).await? == 150_000, "merchant received 3 x 50000");
    env.check(true).await?;
    Ok(format!("pause at block {pause_block} before payment_paid at block {pb}; removed merchant and revoked agent: in-flight payments settled paid; pending id duplicate; next pays agent_paused / merchant_not_allowed"))
}

/// T-35 (panicking migrate): an upgrade whose `migrate` panics reverts the deploy in the same receipt.
async fn t35b(w: &Worker<Sandbox>) -> Result<String> {
    let env = Env::new(w, "t35b", Cfg::default()).await?;
    expect_status!(env.pay(1, &pid("t35b", 1), env.m1.id(), 50_000).await?, "paid");
    let code_before = format!("{:?}", env.w.view_account(&env.vault).await?.contract_state);
    let before = env.state().await?;
    let r = env.owner.call(&env.vault, "upgrade").args(wasm_file("orbit_vault", "orbit_vault_migrate_panic")).deposit(ONE_YOCTO).max_gas().transact().await?;
    let fails: Vec<String> = r.receipt_failures().into_iter().map(|o| format!("{:?}", (*o).clone().into_result().err())).collect();
    ensure!(fails.iter().any(|f| f.contains("E_STATE") && f.contains("migrate always fails")), "expected the deploy+migrate receipt to fail: {fails:?}");
    ensure!(!r.logs().iter().any(|l| l.contains("\"upgraded\"")), "upgraded event emitted for a reverted upgrade");
    let code_after = format!("{:?}", env.w.view_account(&env.vault).await?.contract_state);
    ensure!(code_before == code_after, "code changed: {code_before} -> {code_after}");
    let after = env.state().await?;
    for k in ["available", "paid_total", "counts", "agents", "org", "version"] {
        ensure!(before[k] == after[k], "state {k} changed");
    }
    expect_status!(env.pay(1, &pid("t35b", 2), env.m1.id(), 50_000).await?, "paid");
    env.check(true).await?;
    Ok(format!("upgrade receipt failed E_STATE in migrate; code unchanged {code_after}; state identical; pay still works"))
}

async fn storage_of(env: &Env) -> Result<u64> {
    Ok(env.w.view_account(&env.vault).await?.storage_usage)
}

/// M1: the per-agent daily payment count bounds storage growth; the next payment is rejected and stores nothing.
async fn m1_count(w: &Worker<Sandbox>) -> Result<String> {
    let env = Env::new(w, "m1", Cfg { agents: 1, daily: 10_000_000, org: 10_000_000, ..Cfg::default() }).await?;
    env.owner_call("set_agent_limits", json!({"agent_id": 1, "per_payment_limit": "100000", "daily_limit": "10000000", "max_payments_per_day": 5})).await?.ok()?;
    expect_status!(env.pay(1, &pid("m1", 0), env.m1.id(), 10_000).await?, "paid");
    let s1 = storage_of(&env).await?;
    expect_status!(env.pay(1, &pid("m1", 1), env.m1.id(), 10_000).await?, "paid");
    let record = storage_of(&env).await? - s1;
    let s0 = s1 - record;
    for i in 2..5 {
        expect_status!(env.pay(1, &pid("m1", i), env.m1.id(), 10_000).await?, "paid");
    }
    let s5 = storage_of(&env).await?;
    ensure!(s5 - s0 <= 5 * record, "5 payments grew storage by {} > 5 x {record}", s5 - s0);
    expect_status!(env.pay(1, &pid("m1", 5), env.m1.id(), 10_000).await?, "rejected:over_agent_daily_count");
    ensure!(storage_of(&env).await? == s5, "the rejected payment grew storage");
    let a = Env::agent_state(&env.state().await?, 1).clone();
    ensure!(a["payments_today"] == 5 && a["max_payments_per_day"] == 5 && a["remaining_today"] == "0", "agent view {a}");
    let small = env.pay(1, &pid("m1", 6), env.m1.id(), 9_999).await?;
    ensure!(small.status() == "panic:E_ARGS", "below MIN_PAYMENT: {}", small.status());
    env.check(true).await?;
    Ok(format!("record {record} bytes; 5 payments grew storage {} bytes (<= 5 x record); 6th rejected over_agent_daily_count with no growth; 9999 below MIN_PAYMENT E_ARGS", s5 - s0))
}

/// L2: revoked agents free their slot (50 non-revoked maximum).
async fn l2_slots(w: &Worker<Sandbox>) -> Result<String> {
    let mut env = Env::new(w, "l2", Cfg { agents: 0, ..Cfg::default() }).await?;
    for i in 0..50 {
        env.register(&format!("r{i}"), 1, 2).await?;
    }
    let over = env.owner_call("register_agent", json!({"name": "over", "public_key": SecretKey::from_random(KeyType::ED25519).public_key(), "per_payment_limit": "1", "daily_limit": "2", "allowance": "1"})).await?;
    ensure!(over.status() == "panic:E_ARGS", "51st live agent: {}", over.status());
    for id in 1..=50u32 {
        env.owner_call("revoke_agent", json!({"agent_id": id})).await?.ok()?;
    }
    let id = env.register("fresh", 100_000, 250_000).await?;
    ensure!(id == 51, "fresh agent id {id}");
    expect_status!(env.pay(id, &pid("l2", 1), env.m1.id(), 50_000).await?, "paid");
    env.check(true).await?;
    Ok("50 live agents: 51st E_ARGS; after revoking all 50, a new agent registers (id 51) and pays".into())
}

/// Mainnet build guard: `new` refuses any token other than Circle USDC and a float cap above 20 USDC.
async fn mainnet_guard(w: &Worker<Sandbox>) -> Result<String> {
    let root = w.root_account()?;
    let v = sub(&root, "mguard-vault", 10).await?;
    let owner = sub(&root, "mguard-owner", 5).await?;
    let g = SecretKey::from_random(KeyType::ED25519).public_key();
    let init = |token: &str, cap: &str| json!({"owner": owner.id(), "token": token, "guardian_pk": g, "float_cap": cap, "org_daily_limit": "1000000"});
    let r = v.batch(v.id()).deploy(&wasm_file("orbit_vault", "orbit_vault_mainnet")).call(Function::new("new").args_json(init("mock-ft.test.near", "20000000")).gas(Gas::from_tgas(300))).transact().await?;
    ensure!(r.is_failure() && format!("{:?}", r.clone().into_result().unwrap_err()).contains("E_ARGS"), "mainnet build accepted a non-USDC token");
    let usdc = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
    let r = v.batch(v.id()).deploy(&wasm_file("orbit_vault", "orbit_vault_mainnet")).call(Function::new("new").args_json(init(usdc, "20000001")).gas(Gas::from_tgas(300))).transact().await?;
    ensure!(r.is_failure(), "mainnet build accepted float_cap above 20 USDC");
    let r = v.batch(v.id()).deploy(&wasm_file("orbit_vault", "orbit_vault_mainnet")).call(Function::new("new").args_json(init(usdc, "20000000")).gas(Gas::from_tgas(300))).transact().await?;
    ensure!(r.is_success(), "mainnet build refused USDC with a 20 USDC cap: {:?}", r.into_result().err());
    Ok("mainnet wasm: new refuses a non-USDC token and float_cap 20000001; accepts Circle USDC with 20000000".into())
}

/// T-50, T-51 via state patching: free NEAR below 0.5 makes pay fail closed while pause works;
/// a pending payment still settles with zero free NEAR (storage-neutral callback).
async fn t50_t51(w: &Worker<Sandbox>) -> Result<String> {
    let env = Env::new(w, "t50", Cfg::default()).await?;
    let acct = env.w.view_account(&env.vault).await?;
    let storage_cost = acct.storage_usage as u128 * 10u128.pow(19);
    let original = acct.balance;
    let set_free = |free: u128| {
        let env = &env;
        async move {
            env.w
                .patch(&env.vault)
                .account_from_current(move |a| near_workspaces::types::AccountDetailsPatch::from(a).balance(NearToken::from_yoctonear(storage_cost + free)))
                .transact()
                .await
        }
    };
    // T-50: 0.4 NEAR free.
    set_free(400_000_000_000_000_000_000_000).await?;
    let before = env.state().await?;
    let o = env.pay(1, &pid("t50", 1), env.m1.id(), 50_000).await?;
    ensure!(o.status() == "panic:E_STORAGE_LOW", "pay at 0.4 NEAR free: {}", o.status());
    classify(env.guardian.call(&env.vault, "pause_agent").args_json(json!({"agent_id": 2})).transact().await).ok()?;
    let after = env.state().await?;
    ensure!(before["counts"] == after["counts"] && before["available"] == after["available"], "state changed by E_STORAGE_LOW");
    ensure!(Env::agent_state(&after, 2)["status"] == "paused", "pause not applied at low NEAR");
    env.w.patch(&env.vault).account_from_current(move |a| near_workspaces::types::AccountDetailsPatch::from(a).balance(original)).transact().await?;

    // T-51: reserve with a delayed transfer, then leave zero free NEAR before the callback runs.
    env.owner.call(&env.ft, "set_delay_hops").args_json(json!({"hops": 8})).transact().await?.into_result()?;
    let id = pid("t51", 1);
    let deadline = env.now_ms().await? + 120_000;
    let st = env.agent(1).acct.call(&env.vault, "pay")
        .args_json(json!({"payment_id": id, "merchant": env.m1.id(), "amount": "50000", "deadline_ms": deadline}))
        .gas(Gas::from_tgas(300)).transact_async().await?;
    let t = Instant::now();
    loop {
        let p: Value = env.w.view(&env.vault, "payment").args_json(json!({"payment_id": id})).await?.json()?;
        if p["status"] == "pending" { break; }
        ensure!(t.elapsed() < Duration::from_secs(30), "never pending");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let su = env.w.view_account(&env.vault).await?.storage_usage;
    env.w.patch(&env.vault).account_from_current(move |a| near_workspaces::types::AccountDetailsPatch::from(a).balance(NearToken::from_yoctonear(su as u128 * 10u128.pow(19)))).transact().await?;
    let r = st.await?;
    let v: Value = r.json()?;
    ensure!(v["status"] == "paid", "callback at zero free NEAR: {v}");
    let su2 = env.w.view_account(&env.vault).await?.storage_usage;
    ensure!(su2 <= su, "storage grew in the callback: {su} -> {su2}");
    env.w.patch(&env.vault).account_from_current(move |a| near_workspaces::types::AccountDetailsPatch::from(a).balance(original)).transact().await?;
    env.owner.call(&env.ft, "set_delay_hops").args_json(json!({"hops": 0})).transact().await?.into_result()?;
    env.check(true).await?;
    Ok(format!("0.4 NEAR free: pay E_STORAGE_LOW, guardian pause applied; zero free NEAR: pending payment settled paid, storage {su} -> {su2}"))
}

/// T-12 in the sandbox (opt-in ORBIT_MIDNIGHT=1, 5 to 40 min): fast_forward to just before a real UTC midnight
/// (about 0.3 s of block time per forwarded block), reserve before it, settle after it.
async fn t12_sandbox(w: &Worker<Sandbox>) -> Result<String> {
    if std::env::var("ORBIT_MIDNIGHT").ok().as_deref() != Some("1") {
        bail!("SKIP: set ORBIT_MIDNIGHT=1 (fast_forward to the next UTC midnight takes 5 to 40 minutes)");
    }
    const DAY: u64 = 86_400_000;
    let env = Env::new(w, "t12", Cfg { agents: 1, org: 250_000, ..Cfg::default() }).await?;
    let ts = |h: near_workspaces::types::CryptoHash| async move { w.view_block().block_hash(h).await.map(|b| b.timestamp() / 1_000_000) };
    expect_status!(env.pay(1, &pid("t12", 0), env.m1.id(), 100_000).await?, "paid");
    expect_status!(env.pay(1, &pid("t12", 1), env.m1.id(), 100_000).await?, "paid");
    env.owner.call(&env.ft, "set_delay_hops").args_json(json!({"hops": 20})).transact().await?.into_result()?;
    let day_d = env.now_ms().await? / DAY;
    let midnight = (day_d + 1) * DAY;
    let t0 = Instant::now();
    loop {
        let rem = midnight.saturating_sub(env.now_ms().await?);
        if rem <= 4_000 { break; }
        w.fast_forward(((rem - 2_500) / 300).max(1)).await?;
    }
    let ff_s = t0.elapsed().as_secs();
    let id = pid("t12", 10);
    let st = env.agent(1).acct.call(&env.vault, "pay")
        .args_json(json!({"payment_id": id, "merchant": env.m1.id(), "amount": "50000", "deadline_ms": env.now_ms().await? + 600_000}))
        .gas(Gas::from_tgas(300)).transact_async().await?;
    let r = st.await?;
    let pay_ms = ts(r.outcomes()[1].block_hash).await?;
    let settle = r.outcomes().iter().find(|o| o.logs.iter().any(|l| l.contains("\"payment_paid\""))).map(|o| o.block_hash).ok_or_else(|| anyhow!("no payment_paid"))?;
    let settle_ms = ts(settle).await?;
    ensure!(r.json::<Value>()?["status"] == "paid", "P1 not paid");
    ensure!(pay_ms / DAY == day_d && settle_ms / DAY == day_d + 1, "P1 did not straddle midnight: reserved {pay_ms}, settled {settle_ms}, midnight {midnight}");
    let s = env.state().await?;
    let a = Env::agent_state(&s, 1);
    ensure!(a["spent_today"] == "50000" && a["reserved"] == "0", "P1 not committed to d+1: {a}");
    ensure!(s["org"]["spent_today"] == "50000", "org not committed to d+1");
    env.owner.call(&env.ft, "set_delay_hops").args_json(json!({"hops": 0})).transact().await?.into_result()?;
    expect_status!(env.pay(1, &pid("t12", 11), env.m1.id(), 100_000).await?, "paid");
    expect_status!(env.pay(1, &pid("t12", 12), env.m1.id(), 100_000).await?, "paid");
    expect_status!(env.pay(1, &pid("t12", 13), env.m1.id(), 10_000).await?, "rejected:over_agent_daily_limit");
    let s = env.state().await?;
    ensure!(Env::agent_state(&s, 1)["spent_today"] == "250000" && s["org"]["spent_today"] == "250000", "day d+1 settled total != limit");
    env.check(true).await?;
    Ok(format!("forwarded {ff_s} s real; P1 reserved {} ms before midnight (day d spent 200000 + 50000 reserved = limit), settled {} ms after it and committed to d+1; d+1 settled total 250000 == limit; next pay over_agent_daily_limit", midnight - pay_ms, settle_ms - midnight))
}

// ---------- runner ----------

struct Row {
    id: &'static str,
    inv: &'static str,
    status: &'static str,
    ms: u128,
    detail: String,
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn harness() -> Result<()> {
    let only: Option<Vec<String>> = std::env::var("ORBIT_ONLY").ok().map(|s| s.split(',').map(|x| x.trim().to_string()).collect());
    let w = near_workspaces::sandbox().await?;
    type Scenario = for<'a> fn(&'a Worker<Sandbox>) -> Fut<'a>;
    let scenarios: Vec<(&'static str, &'static str, Scenario)> = vec![
        ("T-01", "I3 I7 I9", |w| Box::pin(t01(w))),
        ("T-02/T-16", "I4", |w| Box::pin(t02_t16(w))),
        ("T-05/T-04/T-19", "I5 I6", |w| Box::pin(t05_pause(w))),
        ("T-06", "I3", |w| Box::pin(t06(w))),
        ("T-07..T-10", "I1 I2", |w| Box::pin(t07_t10(w))),
        ("S-1e", "allowance", |w| Box::pin(s1e_allowance(w))),
        ("T-13", "I1 burst", |w| Box::pin(t13(w))),
        ("T-14", "I2 burst", |w| Box::pin(t14(w))),
        ("T-15", "I1 I2 burst", |w| Box::pin(t15(w))),
        ("T-25/T-26", "I10", |w| Box::pin(t25_t26(w))),
        ("T-21", "I6 I11 agent", |w| Box::pin(t21(w))),
        ("T-22", "I6 guardian", |w| Box::pin(t22(w))),
        ("T-17/T-24", "I6 auth", |w| Box::pin(t17_t24(w))),
        ("T-20/T-32", "I6 I11 keys", |w| Box::pin(t20_t32(w))),
        ("T-27/T-28/T-31", "I7 I8 I12", |w| Box::pin(t27_t31(w))),
        ("T-35", "I6 upgrade", |w| Box::pin(t35(w))),
        ("T-52", "I6 I11 rotate", |w| Box::pin(t52(w))),
        ("T-39", "I9 ring", |w| Box::pin(t39(w))),
        ("T-18/T-34", "I3 I5 in-flight", |w| Box::pin(t18_t34(w))),
        ("T-35b", "I6 upgrade revert", |w| Box::pin(t35b(w))),
        ("T-50/T-51", "liveness storage", |w| Box::pin(t50_t51(w))),
        ("MAINNET-GUARD", "I12 build pins", |w| Box::pin(mainnet_guard(w))),
        ("M1", "storage count", |w| Box::pin(m1_count(w))),
        ("L2", "agent slots", |w| Box::pin(l2_slots(w))),
        ("T-12", "I1 I2 midnight", |w| Box::pin(t12_sandbox(w))),
    ];
    let mut rows = vec![];
    for (id, inv, f) in scenarios {
        if let Some(o) = &only {
            if !o.iter().any(|x| id.contains(x.as_str())) {
                continue;
            }
        }
        let t = Instant::now();
        let res = f(&w).await;
        let ms = t.elapsed().as_millis();
        let (status, detail) = match res {
            Ok(d) => ("PASS", d),
            Err(e) if e.to_string().starts_with("SKIP") => ("SKIP", e.to_string()),
            Err(e) => ("FAIL", format!("{e:#}")),
        };
        println!("[{status}] {id} ({ms} ms): {detail}");
        rows.push(Row { id, inv, status, ms, detail });
    }
    let pass = rows.iter().filter(|r| r.status == "PASS").count();
    let skip = rows.iter().filter(|r| r.status == "SKIP").count();
    let fail = rows.len() - pass - skip;
    println!("\n==================== ORBIT SANDBOX HARNESS ====================");
    println!("{:<16} {:<14} {:<5} {:>7}  evidence", "test", "invariants", "", "ms");
    for r in &rows {
        println!("{:<16} {:<14} {:<5} {:>7}  {}", r.id, r.inv, r.status, r.ms, r.detail);
    }
    println!("VERDICT: PASS {pass}, FAIL {fail}, SKIP {skip} (post-condition helper P1..P8 after every scenario)");
    println!("===============================================================\n");
    let out = format!("{}/../../harness/out", env!("CARGO_MANIFEST_DIR"));
    let _ = std::fs::create_dir_all(&out);
    let json_rows: Vec<Value> = rows
        .iter()
        .map(|r| json!({"id": r.id, "invariants": r.inv, "status": r.status, "ms": r.ms, "evidence": r.detail}))
        .collect();
    let _ = std::fs::write(
        // Full runs write sandbox.json (read by the harness report); filtered runs write sandbox-<filter>.json.
        match &only {
            None => format!("{out}/sandbox.json"),
            Some(o) => format!("{out}/sandbox-{}.json", o.join("_").to_lowercase().replace(['/', ' '], "-")),
        },
        serde_json::to_string_pretty(&json!({"layer": "S", "pass": pass, "fail": fail, "skip": skip, "tests": json_rows}))?,
    );
    ensure!(fail == 0, "{fail} sandbox scenario(s) failed");
    Ok(())
}
