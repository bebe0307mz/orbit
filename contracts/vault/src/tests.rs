//! Unit tests (layer U): mocked block time, predecessor, signer pk and promise results.

use super::*;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};
use std::collections::BTreeMap;
use std::panic::{catch_unwind, AssertUnwindSafe};

const DAY_NS: u64 = NS_PER_DAY;
const T0: u64 = 20_000 * DAY_NS + 12 * 3_600_000_000_000; // day 20000, 12:00 UTC

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn vault_id() -> AccountId {
    acc("vault.test.near")
}
fn owner() -> AccountId {
    acc("owner.test.near")
}
fn token() -> AccountId {
    acc("token.test.near")
}
fn m1() -> AccountId {
    acc("m1.test.near")
}
fn m2() -> AccountId {
    acc("m2.test.near")
}
fn pk(i: u8) -> PublicKey {
    format!("ed25519:{}", bs58::encode([i; 32]).into_string()).parse().unwrap()
}
fn guardian() -> PublicKey {
    pk(200)
}
fn agent_pk(id: u32) -> PublicKey {
    pk(id as u8)
}
fn pid(n: u64) -> String {
    format!("{:064x}", n + 1)
}

/// One mocked call context.
#[derive(Clone)]
struct Ctx {
    pred: AccountId,
    signer_pk: PublicKey,
    ts: u64,
    deposit: u128,
    gas: Gas,
    balance: NearToken,
    result: Option<bool>,
}

/// Fresh mocked chain with empty storage (testing_env! carries storage over on a thread).
fn fresh_chain() {
    let ctx = VMContextBuilder::new().current_account_id(vault_id()).build();
    near_sdk::env::set_blockchain_interface(near_sdk::MockedBlockchain::new(
        ctx,
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        vec![],
        Default::default(),
        Default::default(),
        None,
    ));
}

impl Ctx {
    fn new() -> Self {
        Ctx {
            pred: vault_id(),
            signer_pk: pk(250),
            ts: T0,
            deposit: 0,
            gas: Gas::from_tgas(300),
            balance: NearToken::from_near(20),
            result: None,
        }
    }
    fn apply(&self) {
        let ctx = VMContextBuilder::new()
            .current_account_id(vault_id())
            .predecessor_account_id(self.pred.clone())
            .signer_account_pk(self.signer_pk.clone())
            .block_timestamp(self.ts)
            .block_height(self.ts / 1_000_000_000)
            .attached_deposit(NearToken::from_yoctonear(self.deposit))
            .prepaid_gas(self.gas)
            .account_balance(self.balance)
            .build();
        testing_env!(ctx, near_sdk::test_vm_config(), RuntimeFeesConfig::test(), Default::default(), match self.result {
            None => vec![],
            Some(true) => vec![PromiseResult::Successful(vec![])],
            Some(false) => vec![PromiseResult::Failed],
        });
    }
}

struct H {
    v: Vault,
    ts: u64,
    balance: NearToken,
}

impl H {
    fn ctx(&self) -> Ctx {
        Ctx { ts: self.ts, balance: self.balance, ..Ctx::new() }
    }
    fn as_owner(&self) {
        Ctx { pred: owner(), signer_pk: pk(251), deposit: 1, ..self.ctx() }.apply();
    }
    fn as_agent(&self, id: u32) {
        Ctx { signer_pk: agent_pk(id), ..self.ctx() }.apply();
    }
    fn as_guardian(&self) {
        Ctx { signer_pk: guardian(), ..self.ctx() }.apply();
    }
    fn as_callback(&self, ok: bool) {
        Ctx { result: Some(ok), ..self.ctx() }.apply();
    }

    fn deadline(&self) -> u64 {
        self.ts / 1_000_000 + 120_000
    }

    /// Reserve only (no settlement). Returns Some(result) on rejection, None when a promise was returned.
    fn pay_raw(&mut self, agent: u32, id: &str, merchant: AccountId, amount: u128) -> Option<PayResult> {
        self.as_agent(agent);
        let d = self.deadline();
        match self.v.pay(id.to_string(), merchant, U128(amount), d) {
            PromiseOrValue::Value(r) => Some(r),
            PromiseOrValue::Promise(_) => None,
        }
    }

    fn settle(&mut self, id: &str, ok: bool) -> PayResult {
        self.as_callback(ok);
        self.v.on_payment_settled(id.to_string())
    }

    /// Reserve and settle successfully; returns the final status string and reason.
    fn pay(&mut self, agent: u32, id: &str, merchant: AccountId, amount: u128) -> (String, Option<String>) {
        match self.pay_raw(agent, id, merchant, amount) {
            Some(r) => (r.status, r.reason),
            None => {
                let r = self.settle(id, true);
                (r.status, r.reason)
            }
        }
    }

    fn view(&self) -> StateView {
        self.ctx().apply();
        self.v.state()
    }

    fn agent(&self, id: u32) -> AgentView {
        self.view().agents.into_iter().find(|a| a.id == id).unwrap()
    }
}

/// Post-condition helper (P1 to P5, P8 optional), run after every scenario.
fn check(h: &H, quiescent: bool) {
    let s = h.view();
    let n = |u: U128| u.0;
    assert_eq!(
        n(s.deposited_total),
        n(s.available) + n(s.reserved) + n(s.paid_total) + n(s.withdrawn_total),
        "P1 I7 ledger conservation"
    );
    assert!(n(s.available) + n(s.reserved) <= n(s.float_cap), "P2 I8 float cap");
    assert_eq!(s.counts.next_seq, s.counts.paid + s.counts.failed + s.counts.rejected, "P3 I9 counters");
    let (p, f, r) = s.agents.iter().fold((0, 0, 0), |(p, f, r), a| {
        (p + a.paid_count, f + a.failed_count, r + a.rejected_count)
    });
    assert_eq!((p, f, r), (s.counts.paid, s.counts.failed, s.counts.rejected), "P4 agent counts");
    let agent_reserved: u128 = s.agents.iter().map(|a| a.reserved.0).sum();
    let pending_sum: u128 = s.pending.iter().map(|p| p.amount.0).sum();
    assert_eq!(n(s.org.reserved), agent_reserved, "P5 org.reserved == sum(agent.reserved)");
    assert_eq!(n(s.org.reserved), pending_sum, "P5 org.reserved == sum(pending)");
    assert!(n(s.reserved) >= n(s.org.reserved), "P5 reserved >= org.reserved");
    if quiescent {
        assert!(s.pending.is_empty() && n(s.reserved) == 0, "P8 quiescent");
    }
}

fn expect_panic<F: FnOnce()>(code: &str, f: F) {
    let r = catch_unwind(AssertUnwindSafe(f));
    let err = r.expect_err(&format!("expected panic {code}"));
    let msg = err
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default();
    assert!(msg.contains(code), "expected {code}, got: {msg}");
}

/// Fixture: float 20 USDC, deposit 10 USDC, org 1.00, agents 1..=n each 0.10 per payment, 0.25 daily, m1 allowlisted.
fn setup_with(n_agents: u32, per_payment: u128, daily: u128, org: u128, deposit: u128) -> H {
    fresh_chain();
    let base = Ctx::new();
    base.apply();
    let v = Vault::new(owner(), token(), guardian(), U128(20_000_000), U128(org));
    let mut h = H { v, ts: T0, balance: base.balance };
    h.as_owner();
    h.v.add_merchant(m1(), "Orbit Data".into());
    for i in 1..=n_agents {
        h.as_owner();
        let id = h.v.register_agent(
            format!("a{i}"),
            agent_pk(i),
            U128(per_payment),
            U128(daily),
            U128(NearToken::from_near(1).as_yoctonear()),
        );
        assert_eq!(id, i);
    }
    Ctx { pred: token(), ..h.ctx() }.apply();
    match h.v.ft_on_transfer(owner(), U128(deposit), String::new()) {
        PromiseOrValue::Value(r) => assert_eq!(r.0, 0),
        _ => panic!(),
    }
    h
}

fn setup() -> H {
    setup_with(4, 100_000, 250_000, 1_000_000, 10_000_000)
}

// ---------- keys (I11) ----------

#[test]
fn i11_guardian_and_agent_keys_have_exact_method_lists() {
    fresh_chain();
    Ctx::new().apply();
    let _v = Vault::new(owner(), token(), guardian(), U128(20_000_000), U128(1_000_000));
    let receipts = get_created_receipts();
    let adds: Vec<_> = receipts
        .iter()
        .flat_map(|r| r.actions.iter())
        .filter_map(|a| match a {
            MockAction::AddKeyWithFunctionCall { method_names, receiver_id, allowance, .. } => {
                Some((method_names.clone(), receiver_id.clone(), *allowance))
            }
            _ => None,
        })
        .collect();
    assert_eq!(adds.len(), 1);
    assert_eq!(adds[0].0, vec!["pause_agent".to_string(), "pause_all".to_string()]);
    assert_eq!(adds[0].1, vault_id());
    assert_eq!(adds[0].2, Some(NearToken::from_near(1)));

    let mut h = H { v: _v, ts: T0, balance: NearToken::from_near(20) };
    h.as_owner();
    h.v.register_agent("bot".into(), pk(9), U128(10_000), U128(20_000), U128(10u128.pow(24)));
    let receipts = get_created_receipts();
    let adds: Vec<_> = receipts
        .iter()
        .flat_map(|r| r.actions.iter())
        .filter_map(|a| match a {
            MockAction::AddKeyWithFunctionCall { method_names, receiver_id, allowance, .. } => {
                Some((method_names.clone(), receiver_id.clone(), *allowance))
            }
            MockAction::AddKeyWithFullAccess { .. } => panic!("full access key added"),
            _ => None,
        })
        .collect();
    assert_eq!(adds, vec![(vec!["pay".to_string()], vault_id(), Some(NearToken::from_near(1)))]);
}

#[test]
fn t32_register_agent_validation() {
    let mut h = setup();
    let one = NearToken::from_near(1).as_yoctonear();
    let cases: Vec<(&str, PublicKey, u128, u128, u128)> = vec![
        ("dup-guardian", guardian(), 1, 2, one),
        ("dup-pk", agent_pk(1), 1, 2, one),
        ("limits", pk(60), 3, 2, one),
        ("thirty-three-chars-long-name-xxxx", pk(61), 1, 2, one),
        ("Bad_Name", pk(62), 1, 2, one),
        ("too-rich", pk(63), 1, 2, NearToken::from_near(3).as_yoctonear() + 1),
        ("zero-allowance", pk(64), 1, 2, 0),
    ];
    for (name, key, ppl, daily, allowance) in cases {
        h.as_owner();
        expect_panic("E_ARGS", || {
            h.v.register_agent(name.into(), key, U128(ppl), U128(daily), U128(allowance));
        });
    }
    // 50 agents max (4 exist).
    for i in 5..=50u32 {
        h.as_owner();
        h.v.register_agent(format!("b{i}"), pk(i as u8), U128(1), U128(2), U128(one));
    }
    h.as_owner();
    expect_panic("E_ARGS", || {
        h.v.register_agent("b51".into(), pk(51), U128(1), U128(2), U128(one));
    });
    // Exactly 3 NEAR is allowed (needs a free slot, so check on a fresh vault).
    let mut h2 = setup();
    h2.as_owner();
    h2.v.register_agent("max".into(), pk(70), U128(1), U128(2), U128(NearToken::from_near(3).as_yoctonear()));
}

// ---------- authorization (I6, T-17, T-24) ----------

#[test]
fn t17_pay_panics_before_any_state_change() {
    let mut h = setup();
    let d = h.deadline();
    // Outsider (predecessor is not the vault).
    Ctx { pred: acc("outsider.test.near"), signer_pk: agent_pk(1), ..h.ctx() }.apply();
    expect_panic("E_AUTH", || {
        let _ = h.v.pay(pid(1), m1(), U128(50_000), d);
    });
    // Unknown signer key on the vault account.
    Ctx { signer_pk: pk(99), ..h.ctx() }.apply();
    expect_panic("E_AUTH", || {
        let _ = h.v.pay(pid(1), m1(), U128(50_000), d);
    });
    // Deposit.
    Ctx { signer_pk: agent_pk(1), deposit: 1, ..h.ctx() }.apply();
    expect_panic("E_DEPOSIT", || {
        let _ = h.v.pay(pid(1), m1(), U128(50_000), d);
    });
    // 59 Tgas.
    Ctx { signer_pk: agent_pk(1), gas: Gas::from_tgas(59), ..h.ctx() }.apply();
    expect_panic("E_GAS", || {
        let _ = h.v.pay(pid(1), m1(), U128(50_000), d);
    });
    // Bad ids and amount below MIN_PAYMENT.
    for bad in [&pid(1)[1..], &"AB".repeat(32), &"zz".repeat(32)] {
        h.as_agent(1);
        expect_panic("E_ARGS", || {
            let _ = h.v.pay(bad.to_string(), m1(), U128(50_000), d);
        });
    }
    h.as_agent(1);
    expect_panic("E_ARGS", || {
        let _ = h.v.pay(pid(1), m1(), U128(999), d);
    });
    // Free NEAR below 0.5: balance just above locked storage.
    let s = h.view();
    let locked = s.near.storage_usage as u128 * 10u128.pow(19);
    Ctx { signer_pk: agent_pk(1), balance: NearToken::from_yoctonear(locked + STORAGE_FLOOR.as_yoctonear() - 1), ..h.ctx() }
        .apply();
    expect_panic("E_STORAGE_LOW", || {
        let _ = h.v.pay(pid(1), m1(), U128(50_000), d);
    });
    let s = h.view();
    assert_eq!(s.counts.next_seq, 0, "no ring entry for panics");
    check(&h, true);
}

#[test]
fn t24_owner_methods_refuse_others_and_require_one_yocto() {
    let mut h = setup();
    let callers: Vec<Ctx> = vec![
        Ctx { pred: acc("outsider.test.near"), deposit: 1, ..h.ctx() },
        Ctx { signer_pk: guardian(), ..h.ctx() }, // guardian key signs as the vault
        Ctx { signer_pk: agent_pk(1), ..h.ctx() }, // agent key signs as the vault
    ];
    for c in callers {
        let calls: Vec<Box<dyn Fn(&mut Vault)>> = vec![
            Box::new(|v| {
                v.register_agent("x".into(), pk(80), U128(1), U128(2), U128(1));
            }),
            Box::new(|v| v.set_agent_limits(1, U128(1), U128(2))),
            Box::new(|v| v.set_org_daily_limit(U128(1))),
            Box::new(|v| v.resume_agent(1)),
            Box::new(|v| v.resume_all()),
            Box::new(|v| v.revoke_agent(1)),
            Box::new(|v| v.refill_agent_key(1, U128(1))),
            Box::new(|v| v.add_merchant(m2(), "x".into())),
            Box::new(|v| v.remove_merchant(m1())),
            Box::new(|v| {
                let _ = v.withdraw(U128(1));
            }),
            Box::new(|v| {
                let _ = v.rotate_guardian(pk(81));
            }),
        ];
        for call in calls {
            c.apply();
            expect_panic("E_AUTH", || call(&mut h.v));
        }
    }
    // Outsider cannot pause either.
    for f in [0, 1] {
        Ctx { pred: acc("outsider.test.near"), deposit: 1, ..h.ctx() }.apply();
        expect_panic("E_AUTH", || if f == 0 { h.v.pause_agent(1) } else { h.v.pause_all() });
    }
    // An agent key signing pause methods is refused (protocol also refuses: method list).
    Ctx { signer_pk: agent_pk(1), ..h.ctx() }.apply();
    expect_panic("E_AUTH", || h.v.pause_all());
    // Owner without exactly 1 yocto.
    for dep in [0u128, 2] {
        Ctx { pred: owner(), deposit: dep, ..h.ctx() }.apply();
        expect_panic("E_DEPOSIT", || h.v.set_org_daily_limit(U128(1)));
    }
    let s = h.view();
    assert_eq!(s.org.daily_limit.0, 1_000_000);
    assert!(!s.org.paused);
    check(&h, true);
}

#[test]
fn guardian_pauses_owner_resumes() {
    let mut h = setup();
    h.as_guardian();
    h.v.pause_agent(1);
    h.as_guardian();
    h.v.pause_agent(1); // idempotent
    assert_eq!(h.agent(1).status, AgentStatus::Paused);
    assert_eq!(h.agent(1).remaining_today.0, 0);
    let (st, r) = h.pay(1, &pid(1), m1(), 50_000);
    assert_eq!((st.as_str(), r.as_deref()), ("rejected", Some("agent_paused")));
    let (st, _) = h.pay(2, &pid(2), m1(), 50_000);
    assert_eq!(st, "paid");
    h.as_guardian();
    h.v.pause_all();
    let (_, r) = h.pay(2, &pid(3), m1(), 50_000);
    assert_eq!(r.as_deref(), Some("org_paused"));
    assert!(h.view().agents.iter().all(|a| a.remaining_today.0 == 0));
    h.as_owner();
    h.v.resume_all();
    let (_, r) = h.pay(1, &pid(1), m1(), 50_000);
    assert_eq!(r.as_deref(), Some("agent_paused"), "agent pause kept after resume_all");
    h.as_owner();
    h.v.resume_agent(1);
    let (st, _) = h.pay(1, &pid(1), m1(), 50_000);
    assert_eq!(st, "paid", "rejected ids are not stored, retry works");
    // Revoked agent cannot be paused or resumed.
    h.as_owner();
    h.v.revoke_agent(3);
    h.as_guardian();
    expect_panic("E_STATE", || h.v.pause_agent(3));
    let (_, r) = h.pay(3, &pid(9), m1(), 50_000);
    assert_eq!(r.as_deref(), Some("agent_paused"));
    check(&h, true);
}

// ---------- policy checks ----------

#[test]
fn t01_t07_t08_basic_limits() {
    let mut h = setup();
    let (st, _) = h.pay(1, &pid(1), m1(), 100_000);
    assert_eq!(st, "paid");
    let (_, r) = h.pay(1, &pid(2), m1(), 100_001);
    assert_eq!(r.as_deref(), Some("over_per_payment_limit"));
    let (st, _) = h.pay(1, &pid(3), m1(), 100_000);
    assert_eq!(st, "paid");
    let (_, r) = h.pay(1, &pid(4), m1(), 100_000);
    assert_eq!(r.as_deref(), Some("over_agent_daily_limit"));
    let (st, _) = h.pay(1, &pid(5), m1(), 50_000);
    assert_eq!(st, "paid");
    let a = h.agent(1);
    assert_eq!((a.spent_today.0, a.remaining_today.0, a.paid_count, a.rejected_count), (250_000, 0, 3, 2));
    let (_, r) = h.pay(1, &pid(6), m2(), 1_000);
    assert_eq!(r.as_deref(), Some("merchant_not_allowed"), "allowlist check precedes the daily limit");
    let logs = get_logs();
    assert!(logs.iter().all(|l| l.starts_with("EVENT_JSON:")));
    check(&h, true);
}

#[test]
fn t02_duplicate_payment_id() {
    let mut h = setup();
    assert_eq!(h.pay(1, &pid(1), m1(), 50_000).0, "paid");
    let (_, r) = h.pay(2, &pid(1), m1(), 50_000);
    assert_eq!(r.as_deref(), Some("duplicate_payment"), "same id from another agent");
    // Pending id is also a duplicate.
    assert!(h.pay_raw(1, &pid(2), m1(), 50_000).is_none());
    let r = h.pay_raw(1, &pid(2), m1(), 50_000).unwrap();
    assert_eq!(r.reason.as_deref(), Some("duplicate_payment"));
    h.settle(&pid(2), true);
    // Failed id stays consumed.
    assert!(h.pay_raw(1, &pid(3), m1(), 50_000).is_none());
    assert_eq!(h.settle(&pid(3), false).status, "failed");
    let r = h.pay_raw(1, &pid(3), m1(), 50_000).unwrap();
    assert_eq!(r.reason.as_deref(), Some("duplicate_payment"));
    // Callback cannot run twice for one id.
    h.as_callback(true);
    expect_panic("E_STATE", || {
        h.v.on_payment_settled(pid(1));
    });
    check(&h, true);
}

#[test]
fn t03_deadline_window() {
    let mut h = setup();
    let now = h.ts / 1_000_000;
    let cases = [(now - 1, Some("expired")), (now + 600_001, Some("expired")), (now, None), (now + 600_000, None)];
    for (i, (deadline, want)) in cases.into_iter().enumerate() {
        h.as_agent(1);
        let id = pid(i as u64);
        match h.v.pay(id.clone(), m1(), U128(10_000), deadline) {
            PromiseOrValue::Value(r) => assert_eq!(r.reason.as_deref(), want),
            PromiseOrValue::Promise(_) => {
                assert!(want.is_none());
                h.settle(&id, true);
            }
        }
    }
    check(&h, true);
}

#[test]
fn t09_t10_org_limit_and_balance() {
    let mut h = setup_with(2, 100_000, 300_000, 300_000, 10_000_000);
    for i in 0..2 {
        assert_eq!(h.pay(1, &pid(i), m1(), 100_000).0, "paid");
    }
    assert_eq!(h.pay(1, &pid(2), m1(), 50_000).0, "paid"); // a1 spent 250_000
    assert_eq!(h.pay(2, &pid(3), m1(), 100_000).1.as_deref(), Some("over_org_daily_limit"));
    assert_eq!(h.pay(2, &pid(4), m1(), 50_000).0, "paid");
    assert_eq!(h.view().org.spent_today.0, 300_000);
    check(&h, true);

    let mut h = setup_with(1, 100_000, 250_000, 1_000_000, 120_000);
    assert_eq!(h.pay(1, &pid(0), m1(), 100_000).0, "paid");
    assert_eq!(h.pay(1, &pid(1), m1(), 100_000).1.as_deref(), Some("insufficient_vault_balance"));
    check(&h, true);
}

/// T-11: for each adjacent pair of checks, both failing, the earlier one wins.
#[test]
fn t11_precedence() {
    fn withdraw_down_to(h: &mut H, keep: u128) {
        let amt = h.view().available.0 - keep;
        h.as_owner();
        let _ = h.v.withdraw(U128(amt));
        h.as_callback(true);
        h.v.on_withdraw_settled(U128(amt));
    }
    fn spend_200k(h: &mut H) {
        assert_eq!(h.pay(1, &pid(600), m1(), 100_000).0, "paid");
        assert_eq!(h.pay(1, &pid(601), m1(), 100_000).0, "paid");
    }
    // (want, setup, merchant, amount, expired, id)
    type Setup = fn(&mut H);
    let cases: Vec<(&str, Setup, bool, u128, bool, u64)> = vec![
        ("duplicate_payment", |h| assert_eq!(h.pay(2, &pid(500), m1(), 1_000).0, "paid"), false, 50_000, true, 500),
        ("expired", |h| { h.as_guardian(); h.v.pause_all(); }, false, 50_000, true, 1),
        ("org_paused", |h| { h.as_guardian(); h.v.pause_agent(1); h.as_guardian(); h.v.pause_all(); }, false, 50_000, false, 1),
        ("agent_paused", |h| { h.as_guardian(); h.v.pause_agent(1); }, true, 50_000, false, 1),
        ("merchant_not_allowed", |_| {}, true, 100_001, false, 1),
        ("over_per_payment_limit", spend_200k, false, 100_001, false, 1),
        ("over_agent_daily_limit", |h| { spend_200k(h); h.as_owner(); h.v.set_org_daily_limit(U128(250_000)); }, false, 100_000, false, 1),
        ("over_org_daily_limit", |h| { h.as_owner(); h.v.set_org_daily_limit(U128(50_000)); withdraw_down_to(h, 60_000); }, false, 100_000, false, 1),
    ];
    for (want, setup, unlisted, amount, expired, id) in cases {
        let mut h = setup_with(2, 100_000, 250_000, 1_000_000, 10_000_000);
        setup(&mut h);
        let deadline = if expired { h.ts / 1_000_000 - 1 } else { h.deadline() };
        let merchant = if unlisted { m2() } else { m1() };
        h.as_agent(1);
        match h.v.pay(pid(id), merchant, U128(amount), deadline) {
            PromiseOrValue::Value(r) => assert_eq!(r.reason.as_deref(), Some(want)),
            PromiseOrValue::Promise(_) => panic!("{want}: accepted"),
        }
        check(&h, true);
    }
}

#[test]
fn t25_t26_failed_transfer_refunds_everything() {
    let mut h = setup();
    let before = h.view();
    let a_before = h.agent(1);
    assert!(h.pay_raw(1, &pid(1), m1(), 50_000).is_none());
    let mid = h.agent(1);
    assert_eq!(mid.reserved.0, 50_000);
    assert_eq!(mid.remaining_today.0, a_before.remaining_today.0 - 50_000);
    let r = h.settle(&pid(1), false);
    assert_eq!((r.status.as_str(), r.reason.as_deref()), ("failed", Some("transfer_failed")));
    let after = h.view();
    let a_after = h.agent(1);
    assert_eq!(after.available.0, before.available.0);
    assert_eq!(after.org.spent_today.0, 0);
    assert_eq!(after.org.reserved.0, 0);
    assert_eq!(a_after.remaining_today.0, a_before.remaining_today.0);
    assert_eq!(a_after.spent_today.0, 0);
    assert_eq!((after.counts.failed, a_after.failed_count), (1, 1));
    h.ctx().apply();
    assert_eq!(h.v.payment(pid(1)).unwrap().status, PayStatus::Failed);
    let o = h.v.outcomes(0, 10);
    assert_eq!(o.entries.last().unwrap().reason.as_deref(), Some("transfer_failed"));
    check(&h, true);
}

#[test]
fn callback_requires_a_promise_result() {
    let mut h = setup();
    assert!(h.pay_raw(1, &pid(1), m1(), 50_000).is_none());
    h.ctx().apply(); // no promise results: a direct call by a vault key
    expect_panic("E_AUTH", || {
        h.v.on_payment_settled(pid(1));
    });
    h.settle(&pid(1), true);
    check(&h, true);
}

// ---------- concurrency (unit mirror of T-13 to T-15) ----------

#[test]
fn t13_burst_twenty_reserved_before_any_settles() {
    let mut h = setup_with(1, 100_000, 250_000, 1_000_000, 10_000_000);
    let mut accepted = vec![];
    let mut rejected = 0;
    for i in 0..20 {
        match h.pay_raw(1, &pid(i), m1(), 50_000) {
            None => accepted.push(pid(i)),
            Some(r) => {
                assert_eq!(r.reason.as_deref(), Some("over_agent_daily_limit"));
                rejected += 1;
            }
        }
        let a = h.agent(1);
        assert!(a.spent_today.0 + a.reserved.0 <= 250_000);
    }
    assert_eq!((accepted.len(), rejected), (5, 15));
    for id in &accepted {
        assert_eq!(h.settle(id, true).status, "paid");
    }
    let s = h.view();
    assert_eq!((s.agents[0].spent_today.0, s.agents[0].reserved.0, s.counts.next_seq), (250_000, 0, 20));
    check(&h, true);
}

#[test]
fn t14_org_burst_across_agents() {
    let mut h = setup_with(4, 100_000, 1_000_000, 500_000, 10_000_000);
    let mut accepted = vec![];
    let mut reasons = BTreeMap::new();
    for i in 0..40u64 {
        let agent = (i % 4) as u32 + 1;
        match h.pay_raw(agent, &pid(i), m1(), 50_000) {
            None => accepted.push(pid(i)),
            Some(r) => *reasons.entry(r.reason.unwrap()).or_insert(0) += 1,
        }
    }
    assert_eq!(accepted.len(), 10);
    assert_eq!(reasons.get("over_org_daily_limit"), Some(&30));
    for id in &accepted {
        h.settle(id, true);
    }
    let s = h.view();
    assert_eq!(s.agents.iter().map(|a| a.spent_today.0).sum::<u128>(), 500_000);
    check(&h, true);
}

// ---------- midnight (T-12) ----------

#[test]
fn t12_reserved_before_midnight_settled_after() {
    for p1_ok in [true, false] {
        let mut h = setup_with(1, 100_000, 250_000, 250_000, 10_000_000);
        let day_d = T0 / DAY_NS;
        // a1 spends 200_000 on day d.
        assert_eq!(h.pay(1, &pid(0), m1(), 100_000).0, "paid");
        assert_eq!(h.pay(1, &pid(1), m1(), 100_000).0, "paid");
        // d 23:59:59.500 reserve P1 50_000.
        h.ts = (day_d + 1) * DAY_NS - 500_000_000;
        assert!(h.pay_raw(1, &pid(10), m1(), 50_000).is_none(), "P1 accepted: 200_000 + 50_000 <= 250_000");
        let a = h.agent(1);
        assert_eq!((a.spent_today.0, a.reserved.0, a.remaining_today.0), (200_000, 50_000, 0));
        // d+1 00:00:00.200: view, then reserve P2 and P3.
        h.ts = (day_d + 1) * DAY_NS + 200_000_000;
        let a = h.agent(1);
        assert_eq!((a.spent_today.0, a.reserved.0, a.remaining_today.0), (0, 50_000, 200_000));
        assert!(h.pay_raw(1, &pid(11), m1(), 100_000).is_none());
        assert!(h.pay_raw(1, &pid(12), m1(), 100_000).is_none());
        // Day d+1 is full while P1 is still in flight.
        assert_eq!(h.pay_raw(1, &pid(13), m1(), 1_000).unwrap().reason.as_deref(), Some("over_agent_daily_limit"));
        // 00:00:00.800: P1 settles.
        h.ts = (day_d + 1) * DAY_NS + 800_000_000;
        let paid_before = h.view().paid_total.0;
        let r = h.settle(&pid(10), p1_ok);
        let a = h.agent(1);
        let s = h.view();
        if p1_ok {
            assert_eq!(r.status, "paid");
            assert_eq!((a.spent_today.0, a.reserved.0), (50_000, 200_000), "P1 committed to d+1");
            assert_eq!(s.paid_total.0, paid_before + 50_000);
            assert_eq!(s.org.spent_today.0, 50_000);
        } else {
            assert_eq!(r.status, "failed");
            assert_eq!((a.spent_today.0, a.reserved.0, a.remaining_today.0), (0, 200_000, 50_000));
        }
        h.settle(&pid(11), true);
        h.settle(&pid(12), true);
        let a = h.agent(1);
        let want_spent = if p1_ok { 250_000 } else { 200_000 };
        assert_eq!(a.spent_today.0, want_spent);
        assert_eq!(h.view().org.spent_today.0, want_spent);
        let r4 = h.pay(1, &pid(14), m1(), 50_000);
        let r5 = h.pay(1, &pid(15), m1(), 1_000);
        if p1_ok {
            assert_eq!(r4.1.as_deref(), Some("over_agent_daily_limit"));
            assert_eq!(r5.1.as_deref(), Some("over_agent_daily_limit"));
        } else {
            assert_eq!(r4.0, "paid", "refund freed 50_000 of headroom");
            assert_eq!(r5.1.as_deref(), Some("over_agent_daily_limit"));
        }
        check(&h, true);
    }
}

/// Reference-model property run (T-37 subset): random reserve, settle (ok or fail), pause, resume,
/// limit changes and clock advances across many UTC midnights. After every step:
/// conservation, counters, and per UTC day the committed (settled paid) outflow of each agent and the
/// org never exceeds the daily limit in force during that day (limits are only raised in this run).
#[test]
fn t37_property_no_day_exceeds_limits() {
    let mut seed: u64 = 0x9e37_79b9_7f4a_7c15;
    let mut rnd = move |n: u64| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed % n
    };
    for run in 0..12 {
        let n_agents = 1 + rnd(4) as u32;
        let daily = 50_000 + rnd(5) as u128 * 50_000;
        let org = 100_000 + rnd(6) as u128 * 50_000;
        let mut h = setup_with(n_agents, daily, daily, org, 20_000_000);
        let mut pending: Vec<String> = vec![];
        // settled paid amounts per (day, agent) and per day
        let mut agent_day: BTreeMap<(u64, u32), u128> = BTreeMap::new();
        let mut org_day: BTreeMap<u64, u128> = BTreeMap::new();
        let mut next = 0u64;
        for _step in 0..250 {
            match rnd(10) {
                0..=4 => {
                    let agent = 1 + rnd(n_agents as u64) as u32;
                    let amount = 1_000 + rnd(daily as u64) as u128;
                    let id = pid(run * 10_000 + next);
                    next += 1;
                    if h.pay_raw(agent, &id, m1(), amount).is_none() {
                        pending.push(id);
                    }
                }
                5..=7 if !pending.is_empty() => {
                    let i = rnd(pending.len() as u64) as usize;
                    let id = pending.swap_remove(i);
                    let ok = rnd(5) != 0;
                    h.ctx().apply();
                    let p = h.v.payment(id.clone()).unwrap();
                    let r = h.settle(&id, ok);
                    if r.status == "paid" {
                        let day = h.ts / DAY_NS;
                        *agent_day.entry((day, p.agent_id)).or_default() += p.amount.0;
                        *org_day.entry(day).or_default() += p.amount.0;
                    }
                }
                8 => h.ts += rnd(6 * 3_600) * 1_000_000_000, // up to 6 h, crosses midnights
                _ => {
                    let agent = 1 + rnd(n_agents as u64) as u32;
                    if rnd(2) == 0 {
                        h.as_guardian();
                        h.v.pause_agent(agent);
                    } else if h.agent(agent).status == AgentStatus::Paused {
                        h.as_owner();
                        h.v.resume_agent(agent);
                    }
                }
            }
            for (&(day, agent), &v) in &agent_day {
                assert!(v <= daily, "run {run}: agent {agent} day {day} settled {v} > {daily}");
            }
            for (&day, &v) in &org_day {
                assert!(v <= org, "run {run}: org day {day} settled {v} > {org}");
            }
            // In-flight never pushes any day's exposure over the limit.
            let s = h.view();
            for a in &s.agents {
                assert!(a.spent_today.0 + a.reserved.0 <= daily);
            }
            assert!(s.org.spent_today.0 + s.org.reserved.0 <= org);
            check(&h, false);
        }
        for id in pending.drain(..) {
            h.settle(&id, true);
        }
        check(&h, true);
    }
}

// ---------- deposits (I8, I12) ----------

#[test]
fn t27_t28_t29_deposits() {
    fresh_chain();
    Ctx::new().apply();
    let v = Vault::new(owner(), token(), guardian(), U128(20_000_000), U128(1_000_000));
    let mut h = H { v, ts: T0, balance: NearToken::from_near(20) };
    let deposit = |h: &mut H, pred: AccountId, sender: AccountId, amount: u128| -> u128 {
        Ctx { pred, ..h.ctx() }.apply();
        match h.v.ft_on_transfer(sender, U128(amount), String::new()) {
            PromiseOrValue::Value(r) => r.0,
            _ => panic!(),
        }
    };
    assert_eq!(deposit(&mut h, token(), owner(), 25_000_000), 5_000_000);
    assert_eq!(h.view().available.0, 20_000_000);
    assert_eq!(deposit(&mut h, token(), owner(), 1_000_000), 1_000_000);
    assert_eq!(deposit(&mut h, token(), acc("outsider.test.near"), 1_000_000), 1_000_000);
    assert!(get_logs().iter().any(|l| l.contains("deposit_refused")));
    assert_eq!(deposit(&mut h, acc("fake-token.test.near"), owner(), 1_000_000_000), 1_000_000_000);
    let s = h.view();
    assert_eq!((s.available.0, s.deposited_total.0), (20_000_000, 20_000_000));
    check(&h, true);
}

#[test]
fn t31_withdraw() {
    let mut h = setup();
    let avail = h.view().available.0;
    h.as_owner();
    expect_panic("E_FUNDS", || {
        let _ = h.v.withdraw(U128(avail + 1));
    });
    h.as_owner();
    let _ = h.v.withdraw(U128(1_000_000));
    let s = h.view();
    assert_eq!((s.available.0, s.reserved.0, s.org.reserved.0), (avail - 1_000_000, 1_000_000, 0));
    check(&h, false);
    h.as_callback(true);
    assert!(h.v.on_withdraw_settled(U128(1_000_000)));
    h.as_owner();
    let _ = h.v.withdraw(U128(1_000_000));
    h.as_callback(false);
    assert!(!h.v.on_withdraw_settled(U128(1_000_000)));
    let s = h.view();
    assert_eq!((s.available.0, s.withdrawn_total.0), (avail - 1_000_000, 1_000_000));
    check(&h, true);
}

#[test]
fn t33_limit_below_spent_floors_at_zero() {
    let mut h = setup();
    assert_eq!(h.pay(1, &pid(0), m1(), 100_000).0, "paid");
    assert_eq!(h.pay(1, &pid(1), m1(), 100_000).0, "paid");
    h.as_owner();
    h.v.set_agent_limits(1, U128(50_000), U128(100_000));
    assert_eq!(h.agent(1).remaining_today.0, 0);
    assert_eq!(h.pay(1, &pid(2), m1(), 1_000).1.as_deref(), Some("over_agent_daily_limit"));
    h.as_owner();
    h.v.set_org_daily_limit(U128(100_000));
    assert_eq!(h.pay(2, &pid(3), m1(), 1_000).1.as_deref(), Some("over_org_daily_limit"));
    assert_eq!(h.agent(2).remaining_today.0, 0);
    check(&h, true);
}

// ---------- ring, storage neutrality (T-39, T-51 unit mirrors) ----------

#[test]
fn t39_ring_wraps_and_rejections_are_storage_neutral() {
    let mut h = setup();
    let long_merchant: AccountId = format!("{}.near", "m".repeat(59)).parse().unwrap();
    assert_eq!(long_merchant.len(), 64);
    // Warm up: the first rejection writes the agent entry once.
    h.pay_raw(1, &pid(0), long_merchant.clone(), 1_000);
    let before = h.view().near.storage_usage;
    for i in 1..300 {
        let r = h.pay_raw(1, &pid(i), long_merchant.clone(), 1_000).unwrap();
        assert_eq!(r.reason.as_deref(), Some("merchant_not_allowed"));
    }
    let s = h.view();
    assert_eq!(s.near.storage_usage, before, "300 rejections add no storage");
    assert_eq!(s.counts.next_seq, 300);
    h.ctx().apply();
    let o = h.v.outcomes(0, 500);
    assert_eq!(o.oldest_seq, 300 - 256);
    assert_eq!(o.entries.len(), 100);
    assert_eq!(o.entries[0].seq, 44);
    assert_eq!(o.entries[0].merchant, long_merchant.to_string());
    let tail = h.v.outcomes(290, 100);
    assert_eq!(tail.entries.iter().map(|e| e.seq).collect::<Vec<_>>(), (290..300).collect::<Vec<_>>());
    check(&h, true);
}

#[test]
fn t51_settle_callback_never_grows_storage() {
    let mut h = setup();
    assert!(h.pay_raw(1, &pid(1), m1(), 50_000).is_none());
    assert!(h.pay_raw(1, &pid(2), m1(), 50_000).is_none());
    let before = h.view().near.storage_usage;
    h.settle(&pid(1), true);
    h.settle(&pid(2), false);
    assert!(h.view().near.storage_usage <= before);
    check(&h, true);
}

#[test]
fn views_match_spine_json_shape() {
    let mut h = setup();
    assert_eq!(h.pay(1, &pid(1), m1(), 50_000).0, "paid");
    assert!(h.pay_raw(2, &pid(2), m1(), 20_000).is_none());
    h.ctx().apply();
    let s = serde_json::to_value(h.v.state()).unwrap();
    for k in [
        "block_height", "timestamp_ms", "day", "version", "near", "token", "float_cap", "available", "reserved",
        "deposited_total", "withdrawn_total", "paid_total", "org", "counts", "agents", "merchants", "pending",
        "pending_count",
    ] {
        assert!(s.get(k).is_some(), "state() missing {k}");
    }
    assert!(s["available"].is_string() && s["org"]["daily_limit"].is_string());
    assert!(s["near"]["balance"].is_string() && s["near"]["storage_usage"].is_u64());
    assert_eq!(s["agents"][0]["status"], "active");
    assert!(s["agents"][0]["remaining_today"].is_string());
    assert_eq!(s["pending"][0]["amount"], "20000");
    assert_eq!(s["pending_count"], 1);
    let o = serde_json::to_value(h.v.outcomes(0, 10)).unwrap();
    assert_eq!(o["entries"][0]["kind"], "paid");
    assert!(o["entries"][0]["reason"].is_null());
    assert_eq!(o["entries"][0]["amount"], "50000");
    assert_eq!(o["entries"][0]["merchant"], "m1.test.near");
    let p = serde_json::to_value(h.v.payment(pid(2))).unwrap();
    assert_eq!(p["status"], "pending");
    assert!(serde_json::to_value(h.v.payment(pid(77))).unwrap().is_null());
}
