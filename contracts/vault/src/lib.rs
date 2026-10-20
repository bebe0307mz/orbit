//! Orbit vault: one funded NEAR account, many AI agents, on-chain limits and pause.
//!
//! Authorities:
//! - owner: `predecessor == owner` plus exactly 1 yoctoNEAR (full-access key only),
//! - guardian: FC key on the vault limited to `pause_agent,pause_all`,
//! - agents: FC keys on the vault limited to `pay`, identified by `signer_account_pk`.
//!
//! Policy rejections never panic: they are recorded in the outcome ring and returned.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableMap, IterableSet, LookupMap};
use near_sdk::{
    env, ext_contract, near, AccountId, Allowance, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError, PromiseOrValue, PublicKey,
};

pub const MIN_PAYMENT: u128 = 1_000;
pub const PAY_GAS_MIN: Gas = Gas::from_tgas(60);
pub const FT_TRANSFER_GAS: Gas = Gas::from_tgas(15);
pub const SETTLE_GAS: Gas = Gas::from_tgas(20);
pub const KEY_CALLBACK_GAS: Gas = Gas::from_tgas(10);
pub const MIGRATE_GAS: Gas = Gas::from_tgas(30);
pub const MAX_AGENT_ALLOWANCE: NearToken = NearToken::from_near(3);
pub const GUARDIAN_ALLOWANCE: NearToken = NearToken::from_near(1);
pub const STORAGE_FLOOR: NearToken = NearToken::from_millinear(500);
pub const MAX_AGENTS: u32 = 50;
pub const MAX_MERCHANTS: u32 = 20;
pub const RING_SIZE: u64 = 256;
pub const DEADLINE_WINDOW_MS: u64 = 600_000;
pub const MAX_VIEW_PENDING: usize = 100;
pub const MAX_VIEW_OUTCOMES: u32 = 100;
pub const NS_PER_DAY: u64 = 86_400_000_000_000;
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const AGENT_METHODS: &str = "pay";
pub const GUARDIAN_METHODS: &str = "pause_agent,pause_all";
pub const EVENT_STANDARD: &str = "orbit-vault";
pub const EVENT_VERSION: &str = "1.0.0";

#[cfg(feature = "mainnet")]
pub const MAINNET_USDC: &str = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
#[cfg(feature = "mainnet")]
pub const MAINNET_MAX_FLOAT: u128 = 20_000_000;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Agents,
    AgentByPk,
    Merchants,
    Payments,
    Pending,
    Ring,
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "lowercase")]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AgentStatus {
    Active,
    Paused,
    Revoked,
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "lowercase")]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PayStatus {
    Pending,
    Paid,
    Failed,
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "lowercase")]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum OutcomeKind {
    Paid,
    Failed,
    Rejected,
}

/// Reason codes. The u8 value is stored in the ring (0 = none).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum Reason {
    DuplicatePayment = 1,
    Expired = 2,
    OrgPaused = 3,
    AgentPaused = 4,
    MerchantNotAllowed = 5,
    OverPerPaymentLimit = 6,
    OverAgentDailyLimit = 7,
    OverOrgDailyLimit = 8,
    InsufficientVaultBalance = 9,
    TransferFailed = 10,
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::DuplicatePayment => "duplicate_payment",
            Reason::Expired => "expired",
            Reason::OrgPaused => "org_paused",
            Reason::AgentPaused => "agent_paused",
            Reason::MerchantNotAllowed => "merchant_not_allowed",
            Reason::OverPerPaymentLimit => "over_per_payment_limit",
            Reason::OverAgentDailyLimit => "over_agent_daily_limit",
            Reason::OverOrgDailyLimit => "over_org_daily_limit",
            Reason::InsufficientVaultBalance => "insufficient_vault_balance",
            Reason::TransferFailed => "transfer_failed",
        }
    }

    pub fn from_code(code: u8) -> Option<Reason> {
        use Reason::*;
        [
            DuplicatePayment,
            Expired,
            OrgPaused,
            AgentPaused,
            MerchantNotAllowed,
            OverPerPaymentLimit,
            OverAgentDailyLimit,
            OverOrgDailyLimit,
            InsufficientVaultBalance,
            TransferFailed,
        ]
        .into_iter()
        .find(|r| *r as u8 == code)
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Agent {
    pub name: String,
    pub pk: PublicKey,
    pub per_payment_limit: u128,
    pub daily_limit: u128,
    pub day: u32,
    pub spent: u128,
    pub reserved: u128,
    pub status: AgentStatus,
    pub paid_count: u64,
    pub rejected_count: u64,
    pub failed_count: u64,
}

impl Agent {
    /// Lazy day rollover: `spent` resets, `reserved` never does.
    fn roll(&mut self, today: u32) {
        if self.day < today {
            self.day = today;
            self.spent = 0;
        }
    }

    fn spent_on(&self, today: u32) -> u128 {
        if self.day < today {
            0
        } else {
            self.spent
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Payment {
    pub agent_id: u32,
    pub merchant: AccountId,
    pub amount: u128,
    pub day: u32,
    pub reserved_at_ms: u64,
    pub status: PayStatus,
}

/// Fixed-size ring entry, so overwriting a slot never changes storage usage.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Outcome {
    pub seq: u64,
    pub kind: OutcomeKind,
    pub agent_id: u32,
    pub payment_id: [u8; 32],
    pub merchant: [u8; 64],
    pub amount: u128,
    pub reason: u8,
    pub block_height: u64,
    pub timestamp_ms: u64,
}

// ---------- JSON views ----------

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PayResult {
    pub status: String,
    pub reason: Option<String>,
    pub payment_id: String,
    pub seq: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct NearView {
    pub balance: U128,
    pub storage_usage: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct OrgView {
    pub daily_limit: U128,
    pub spent_today: U128,
    pub reserved: U128,
    pub paused: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct CountsView {
    pub paid: u64,
    pub failed: u64,
    pub rejected: u64,
    pub next_seq: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct AgentView {
    pub id: u32,
    pub name: String,
    pub pk: PublicKey,
    pub status: AgentStatus,
    pub per_payment_limit: U128,
    pub daily_limit: U128,
    pub spent_today: U128,
    pub reserved: U128,
    pub remaining_today: U128,
    pub paid_count: u64,
    pub rejected_count: u64,
    pub failed_count: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct MerchantView {
    pub account: AccountId,
    pub name: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct PendingView {
    pub payment_id: String,
    pub agent_id: u32,
    pub merchant: AccountId,
    pub amount: U128,
    pub reserved_at_ms: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct StateView {
    pub block_height: u64,
    pub timestamp_ms: u64,
    pub day: u32,
    pub version: String,
    pub owner: AccountId,
    pub guardian_pk: PublicKey,
    pub near: NearView,
    pub token: AccountId,
    pub float_cap: U128,
    pub available: U128,
    pub reserved: U128,
    pub deposited_total: U128,
    pub withdrawn_total: U128,
    pub paid_total: U128,
    pub org: OrgView,
    pub counts: CountsView,
    pub agents: Vec<AgentView>,
    pub merchants: Vec<MerchantView>,
    pub pending: Vec<PendingView>,
    pub pending_count: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct OutcomeView {
    pub seq: u64,
    pub kind: OutcomeKind,
    pub agent_id: u32,
    pub payment_id: String,
    pub merchant: String,
    pub amount: U128,
    pub reason: Option<String>,
    pub block_height: u64,
    pub timestamp_ms: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct OutcomesView {
    pub oldest_seq: u64,
    pub entries: Vec<OutcomeView>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct PaymentView {
    pub agent_id: u32,
    pub merchant: AccountId,
    pub amount: U128,
    pub day: u32,
    pub reserved_at_ms: u64,
    pub status: PayStatus,
}

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

// ---------- helpers ----------

fn fail(code: &str, msg: &str) -> ! {
    env::panic_str(&format!("{code}: {msg}"))
}

fn add(a: u128, b: u128) -> u128 {
    a.checked_add(b).unwrap_or_else(|| fail("E_OVERFLOW", "u128 add"))
}

fn sub(a: u128, b: u128) -> u128 {
    a.checked_sub(b).unwrap_or_else(|| fail("E_OVERFLOW", "u128 sub"))
}

fn today() -> u32 {
    (env::block_timestamp() / NS_PER_DAY) as u32
}

fn parse_payment_id(id: &str) -> [u8; 32] {
    let ok = id.len() == 64 && id.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c));
    if !ok {
        fail("E_ARGS", "payment_id must be 64 lowercase hex chars");
    }
    let mut out = [0u8; 32];
    hex::decode_to_slice(id, &mut out).unwrap_or_else(|_| fail("E_ARGS", "payment_id hex"));
    out
}

fn encode_merchant(account: &AccountId) -> [u8; 64] {
    let mut out = [0u8; 64];
    let b = account.as_bytes();
    out[..b.len()].copy_from_slice(b);
    out
}

fn decode_merchant(raw: &[u8; 64]) -> String {
    let end = raw.iter().position(|b| *b == 0).unwrap_or(64);
    String::from_utf8_lossy(&raw[..end]).into_owned()
}

fn valid_name(name: &str) -> bool {
    (1..=32).contains(&name.len())
        && name.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

fn emit(event: &str, data: serde_json::Value) {
    let ev = json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{ev}"));
}

fn single_promise_ok() -> bool {
    if env::promise_results_count() != 1 {
        fail("E_AUTH", "callback without a promise result");
    }
    match env::promise_result_checked(0, 1024) {
        Err(PromiseError::Failed) => false,
        // Ok, or TooLong (the only other variant in near-sdk 5.27): the transfer receipt succeeded.
        _ => true,
    }
}

// ---------- contract ----------

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct Vault {
    owner: AccountId,
    token: AccountId,
    guardian_pk: PublicKey,
    float_cap: u128,
    available: u128,
    reserved: u128,
    deposited_total: u128,
    withdrawn_total: u128,
    paid_total: u128,
    org_daily_limit: u128,
    org_day: u32,
    org_spent: u128,
    org_reserved: u128,
    org_paused: bool,
    agents: IterableMap<u32, Agent>,
    agent_by_pk: LookupMap<PublicKey, u32>,
    next_agent_id: u32,
    merchants: IterableMap<AccountId, String>,
    payments: LookupMap<[u8; 32], Payment>,
    pending: IterableSet<[u8; 32]>,
    ring: LookupMap<u32, Outcome>,
    next_seq: u64,
    paid_count: u64,
    failed_count: u64,
    rejected_count: u64,
}

#[near]
impl Vault {
    #[init]
    #[private]
    pub fn new(
        owner: AccountId,
        token: AccountId,
        guardian_pk: PublicKey,
        float_cap: U128,
        org_daily_limit: U128,
    ) -> Self {
        let me = env::current_account_id();
        if owner == me {
            fail("E_ARGS", "owner must not be the vault account");
        }
        #[cfg(feature = "mainnet")]
        {
            if token.as_str() != MAINNET_USDC || float_cap.0 > MAINNET_MAX_FLOAT {
                fail("E_ARGS", "mainnet build pins USDC and float_cap <= 20 USDC");
            }
        }
        let mut this = Self {
            owner,
            token,
            guardian_pk: guardian_pk.clone(),
            float_cap: float_cap.0,
            available: 0,
            reserved: 0,
            deposited_total: 0,
            withdrawn_total: 0,
            paid_total: 0,
            org_daily_limit: org_daily_limit.0,
            org_day: today(),
            org_spent: 0,
            org_reserved: 0,
            org_paused: false,
            agents: IterableMap::new(StorageKey::Agents),
            agent_by_pk: LookupMap::new(StorageKey::AgentByPk),
            next_agent_id: 1,
            merchants: IterableMap::new(StorageKey::Merchants),
            payments: LookupMap::new(StorageKey::Payments),
            pending: IterableSet::new(StorageKey::Pending),
            ring: LookupMap::new(StorageKey::Ring),
            next_seq: 0,
            paid_count: 0,
            failed_count: 0,
            rejected_count: 0,
        };
        // Preallocate every ring slot so later overwrites are storage-neutral.
        for slot in 0..RING_SIZE as u32 {
            this.ring.insert(
                slot,
                Outcome {
                    seq: 0,
                    kind: OutcomeKind::Rejected,
                    agent_id: 0,
                    payment_id: [0; 32],
                    merchant: [0; 64],
                    amount: 0,
                    reason: 0,
                    block_height: 0,
                    timestamp_ms: 0,
                },
            );
        }
        Promise::new(me.clone())
            .add_access_key_allowance(
                guardian_pk,
                Allowance::limited(GUARDIAN_ALLOWANCE).unwrap(),
                me,
                GUARDIAN_METHODS,
            )
            .detach();
        this
    }

    // ---------- agent ----------

    #[payable]
    pub fn pay(
        &mut self,
        payment_id: String,
        merchant: AccountId,
        amount: U128,
        deadline_ms: u64,
    ) -> PromiseOrValue<PayResult> {
        // 1. Panics: no state change, no outcome.
        let me = env::current_account_id();
        if env::predecessor_account_id() != me {
            fail("E_AUTH", "pay must be signed by an agent key on the vault");
        }
        let agent_id = *self
            .agent_by_pk
            .get(&env::signer_account_pk())
            .unwrap_or_else(|| fail("E_AUTH", "unknown agent key"));
        if !env::attached_deposit().is_zero() {
            fail("E_DEPOSIT", "pay takes no deposit");
        }
        if env::prepaid_gas() < PAY_GAS_MIN {
            fail("E_GAS", "pay needs at least 60 Tgas");
        }
        let pid = parse_payment_id(&payment_id);
        let amount = amount.0;
        if amount < MIN_PAYMENT {
            fail("E_ARGS", "amount below MIN_PAYMENT");
        }
        if self.free_near() < STORAGE_FLOOR.as_yoctonear() {
            fail("E_STORAGE_LOW", "vault free NEAR below 0.5");
        }

        // 2. Roll days.
        let today = today();
        let now_ms = env::block_timestamp_ms();
        self.roll_org(today);
        let mut agent = self.agents.get(&agent_id).cloned().unwrap();
        agent.roll(today);

        // 3. Policy checks, fixed order; the first failure is the reason.
        let reason = if self.payments.contains_key(&pid) {
            Some(Reason::DuplicatePayment)
        } else if now_ms > deadline_ms || deadline_ms > now_ms.saturating_add(DEADLINE_WINDOW_MS) {
            Some(Reason::Expired)
        } else if self.org_paused {
            Some(Reason::OrgPaused)
        } else if agent.status != AgentStatus::Active {
            Some(Reason::AgentPaused)
        } else if !self.merchants.contains_key(&merchant) {
            Some(Reason::MerchantNotAllowed)
        } else if amount > agent.per_payment_limit {
            Some(Reason::OverPerPaymentLimit)
        } else if add(add(agent.spent, agent.reserved), amount) > agent.daily_limit {
            Some(Reason::OverAgentDailyLimit)
        } else if add(add(self.org_spent, self.org_reserved), amount) > self.org_daily_limit {
            Some(Reason::OverOrgDailyLimit)
        } else if amount > self.available {
            Some(Reason::InsufficientVaultBalance)
        } else {
            None
        };

        if let Some(reason) = reason {
            // 4. Rejection: recorded, not stored as a payment, retryable once fixed.
            agent.rejected_count += 1;
            self.rejected_count += 1;
            self.agents.insert(agent_id, agent);
            let seq = self.push_outcome(OutcomeKind::Rejected, agent_id, &pid, &merchant, amount, Some(reason));
            emit(
                "payment_rejected",
                json!({"payment_id": payment_id, "agent_id": agent_id, "merchant": merchant,
                       "amount": U128(amount), "seq": seq, "reason": reason.as_str()}),
            );
            return PromiseOrValue::Value(PayResult {
                status: "rejected".into(),
                reason: Some(reason.as_str().into()),
                payment_id,
                seq,
            });
        }

        // 5. Acceptance: reserve on all ledgers, then transfer and settle.
        self.payments.insert(
            pid,
            Payment {
                agent_id,
                merchant: merchant.clone(),
                amount,
                day: today,
                reserved_at_ms: now_ms,
                status: PayStatus::Pending,
            },
        );
        self.pending.insert(pid);
        agent.reserved = add(agent.reserved, amount);
        self.agents.insert(agent_id, agent);
        self.org_reserved = add(self.org_reserved, amount);
        self.reserved = add(self.reserved, amount);
        self.available = sub(self.available, amount);
        emit(
            "payment_reserved",
            json!({"payment_id": payment_id, "agent_id": agent_id, "merchant": merchant, "amount": U128(amount)}),
        );
        let memo = format!("orbit:{payment_id}");
        PromiseOrValue::Promise(
            ext_ft::ext(self.token.clone())
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .with_static_gas(FT_TRANSFER_GAS)
                .ft_transfer(merchant, U128(amount), Some(memo))
                .then(Self::ext(me).with_static_gas(SETTLE_GAS).on_payment_settled(payment_id)),
        )
    }

    /// Settles a reserved payment. Storage-neutral: status flip, ring overwrite, pending removal.
    #[private]
    pub fn on_payment_settled(&mut self, payment_id: String) -> PayResult {
        let ok = single_promise_ok();
        let pid = parse_payment_id(&payment_id);
        let mut p = self
            .payments
            .get(&pid)
            .cloned()
            .unwrap_or_else(|| fail("E_STATE", "unknown payment"));
        if p.status != PayStatus::Pending {
            fail("E_STATE", "payment not pending");
        }
        let today = today();
        self.roll_org(today);
        let mut agent = self.agents.get(&p.agent_id).cloned().unwrap();
        agent.roll(today);

        let a = p.amount;
        self.reserved = sub(self.reserved, a);
        agent.reserved = sub(agent.reserved, a);
        self.org_reserved = sub(self.org_reserved, a);
        let (kind, reason, status, event) = if ok {
            self.paid_total = add(self.paid_total, a);
            agent.spent = add(agent.spent, a);
            self.org_spent = add(self.org_spent, a);
            agent.paid_count += 1;
            self.paid_count += 1;
            (OutcomeKind::Paid, None, PayStatus::Paid, "payment_paid")
        } else {
            self.available = add(self.available, a);
            agent.failed_count += 1;
            self.failed_count += 1;
            (OutcomeKind::Failed, Some(Reason::TransferFailed), PayStatus::Failed, "payment_failed")
        };
        p.status = status;
        let agent_id = p.agent_id;
        let merchant = p.merchant.clone();
        self.payments.insert(pid, p);
        self.pending.remove(&pid);
        self.agents.insert(agent_id, agent);
        let seq = self.push_outcome(kind, agent_id, &pid, &merchant, a, reason);
        let reason_str = reason.map(|r| r.as_str().to_string());
        emit(
            event,
            json!({"payment_id": payment_id, "agent_id": agent_id, "merchant": merchant,
                   "amount": U128(a), "seq": seq, "reason": reason_str}),
        );
        PayResult {
            status: if ok { "paid".into() } else { "failed".into() },
            reason: reason_str,
            payment_id,
            seq,
        }
    }

    // ---------- guardian (or owner) ----------

    #[payable]
    pub fn pause_agent(&mut self, agent_id: u32) {
        let by = self.auth_guardian_or_owner();
        let mut agent = self.agent_or_panic(agent_id);
        match agent.status {
            AgentStatus::Revoked => fail("E_STATE", "agent revoked"),
            AgentStatus::Paused => {}
            AgentStatus::Active => {
                agent.status = AgentStatus::Paused;
                self.agents.insert(agent_id, agent);
            }
        }
        emit("agent_paused", json!({"agent_id": agent_id, "by": by}));
    }

    #[payable]
    pub fn pause_all(&mut self) {
        let by = self.auth_guardian_or_owner();
        self.org_paused = true;
        emit("org_paused", json!({"by": by}));
    }

    // ---------- owner ----------

    #[payable]
    pub fn register_agent(
        &mut self,
        name: String,
        public_key: PublicKey,
        per_payment_limit: U128,
        daily_limit: U128,
        allowance: U128,
    ) -> u32 {
        self.auth_owner();
        if !valid_name(&name) {
            fail("E_ARGS", "name must be 1 to 32 chars [a-z0-9-]");
        }
        if self.agent_by_pk.contains_key(&public_key) || public_key == self.guardian_pk {
            fail("E_ARGS", "public key already used");
        }
        if per_payment_limit.0 > daily_limit.0 {
            fail("E_ARGS", "per_payment_limit > daily_limit");
        }
        if self.agents.len() >= MAX_AGENTS {
            fail("E_ARGS", "max 50 agents");
        }
        let allowance = Self::check_allowance(allowance);
        let id = self.next_agent_id;
        self.next_agent_id += 1;
        self.agents.insert(
            id,
            Agent {
                name: name.clone(),
                pk: public_key.clone(),
                per_payment_limit: per_payment_limit.0,
                daily_limit: daily_limit.0,
                day: today(),
                spent: 0,
                reserved: 0,
                status: AgentStatus::Active,
                paid_count: 0,
                rejected_count: 0,
                failed_count: 0,
            },
        );
        self.agent_by_pk.insert(public_key.clone(), id);
        let me = env::current_account_id();
        Promise::new(me.clone())
            .add_access_key_allowance(public_key.clone(), allowance, me, AGENT_METHODS)
            .detach();
        emit(
            "agent_registered",
            json!({"agent_id": id, "name": name, "pk": public_key,
                   "per_payment_limit": per_payment_limit, "daily_limit": daily_limit}),
        );
        id
    }

    #[payable]
    pub fn set_agent_limits(&mut self, agent_id: u32, per_payment_limit: U128, daily_limit: U128) {
        self.auth_owner();
        if per_payment_limit.0 > daily_limit.0 {
            fail("E_ARGS", "per_payment_limit > daily_limit");
        }
        let mut agent = self.agent_or_panic(agent_id);
        if agent.status == AgentStatus::Revoked {
            fail("E_STATE", "agent revoked");
        }
        agent.per_payment_limit = per_payment_limit.0;
        agent.daily_limit = daily_limit.0;
        self.agents.insert(agent_id, agent);
        emit(
            "agent_limits_set",
            json!({"agent_id": agent_id, "per_payment_limit": per_payment_limit, "daily_limit": daily_limit}),
        );
    }

    #[payable]
    pub fn set_org_daily_limit(&mut self, limit: U128) {
        self.auth_owner();
        self.org_daily_limit = limit.0;
        emit("org_limit_set", json!({"daily_limit": limit}));
    }

    #[payable]
    pub fn resume_agent(&mut self, agent_id: u32) {
        self.auth_owner();
        let mut agent = self.agent_or_panic(agent_id);
        if agent.status != AgentStatus::Paused {
            fail("E_STATE", "agent not paused");
        }
        agent.status = AgentStatus::Active;
        self.agents.insert(agent_id, agent);
        emit("agent_resumed", json!({"agent_id": agent_id}));
    }

    #[payable]
    pub fn resume_all(&mut self) {
        self.auth_owner();
        self.org_paused = false;
        emit("org_resumed", json!({}));
    }

    #[payable]
    pub fn revoke_agent(&mut self, agent_id: u32) {
        self.auth_owner();
        let mut agent = self.agent_or_panic(agent_id);
        if agent.status == AgentStatus::Revoked {
            fail("E_STATE", "agent already revoked");
        }
        agent.status = AgentStatus::Revoked;
        let pk = agent.pk.clone();
        self.agents.insert(agent_id, agent);
        Promise::new(env::current_account_id()).delete_key(pk).detach();
        emit("agent_revoked", json!({"agent_id": agent_id}));
    }

    #[payable]
    pub fn refill_agent_key(&mut self, agent_id: u32, allowance: U128) {
        self.auth_owner();
        let agent = self.agent_or_panic(agent_id);
        if agent.status == AgentStatus::Revoked {
            fail("E_STATE", "agent revoked");
        }
        let allowance_yocto = allowance;
        let allowance = Self::check_allowance(allowance);
        let me = env::current_account_id();
        Promise::new(me.clone())
            .delete_key(agent.pk.clone())
            .add_access_key_allowance(agent.pk, allowance, me, AGENT_METHODS)
            .detach();
        emit("agent_key_refilled", json!({"agent_id": agent_id, "allowance": allowance_yocto}));
    }

    #[payable]
    pub fn add_merchant(&mut self, account: AccountId, name: String) {
        self.auth_owner();
        if name.is_empty() || name.len() > 64 {
            fail("E_ARGS", "merchant name must be 1 to 64 bytes");
        }
        if !self.merchants.contains_key(&account) && self.merchants.len() >= MAX_MERCHANTS {
            fail("E_ARGS", "max 20 merchants");
        }
        self.merchants.insert(account.clone(), name.clone());
        emit("merchant_added", json!({"account": account, "name": name}));
    }

    #[payable]
    pub fn remove_merchant(&mut self, account: AccountId) {
        self.auth_owner();
        if self.merchants.remove(&account).is_none() {
            fail("E_ARGS", "unknown merchant");
        }
        emit("merchant_removed", json!({"account": account}));
    }

    #[payable]
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        self.auth_owner();
        let a = amount.0;
        if a == 0 {
            fail("E_ARGS", "amount must be positive");
        }
        if a > self.available {
            fail("E_FUNDS", "amount above available");
        }
        self.available = sub(self.available, a);
        self.reserved = add(self.reserved, a);
        emit("withdraw_started", json!({"amount": amount, "to": self.owner}));
        ext_ft::ext(self.token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(FT_TRANSFER_GAS)
            .ft_transfer(self.owner.clone(), amount, Some("orbit:withdraw".into()))
            .then(Self::ext(env::current_account_id()).with_static_gas(SETTLE_GAS).on_withdraw_settled(amount))
    }

    #[private]
    pub fn on_withdraw_settled(&mut self, amount: U128) -> bool {
        let ok = single_promise_ok();
        let a = amount.0;
        self.reserved = sub(self.reserved, a);
        if ok {
            self.withdrawn_total = add(self.withdrawn_total, a);
            emit("withdrawn", json!({"amount": amount}));
        } else {
            self.available = add(self.available, a);
            emit("withdraw_failed", json!({"amount": amount}));
        }
        ok
    }

    #[payable]
    pub fn rotate_guardian(&mut self, new_pk: PublicKey) -> Promise {
        self.auth_owner();
        if self.agent_by_pk.contains_key(&new_pk) || new_pk == self.guardian_pk {
            fail("E_ARGS", "new guardian key already used");
        }
        let me = env::current_account_id();
        Promise::new(me.clone())
            .delete_key(self.guardian_pk.clone())
            .add_access_key_allowance(
                new_pk.clone(),
                Allowance::limited(GUARDIAN_ALLOWANCE).unwrap(),
                me.clone(),
                GUARDIAN_METHODS,
            )
            .then(Self::ext(me).with_static_gas(KEY_CALLBACK_GAS).on_guardian_rotated(new_pk))
    }

    #[private]
    pub fn on_guardian_rotated(&mut self, new_pk: PublicKey) -> bool {
        let ok = single_promise_ok();
        if ok {
            let old = std::mem::replace(&mut self.guardian_pk, new_pk.clone());
            emit("guardian_rotated", json!({"old_pk": old, "new_pk": new_pk}));
        } else {
            emit("guardian_rotate_failed", json!({"new_pk": new_pk}));
        }
        ok
    }

    /// Runs in the same batch receipt as the code deploy (see `upgrade` below), so a panic
    /// here reverts the deploy.
    #[private]
    #[init(ignore_state)]
    pub fn migrate(code_hash: Option<String>) -> Self {
        let this: Self = env::state_read().unwrap_or_else(|| fail("E_STATE", "no state"));
        emit("upgraded", json!({"code_hash": code_hash, "version": VERSION}));
        this
    }

    // ---------- token receiver ----------

    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let _ = msg;
        if env::predecessor_account_id() != self.token {
            return PromiseOrValue::Value(amount);
        }
        if sender_id != self.owner {
            emit("deposit_refused", json!({"sender_id": sender_id, "amount": amount}));
            return PromiseOrValue::Value(amount);
        }
        let held = add(self.available, self.reserved);
        let headroom = self.float_cap.saturating_sub(held);
        let accepted = amount.0.min(headroom);
        self.available = add(self.available, accepted);
        self.deposited_total = add(self.deposited_total, accepted);
        let refunded = amount.0 - accepted;
        emit(
            "deposited",
            json!({"sender_id": sender_id, "accepted": U128(accepted), "refunded": U128(refunded)}),
        );
        PromiseOrValue::Value(U128(refunded))
    }

    // ---------- views ----------

    pub fn state(&self) -> StateView {
        let today = today();
        let org_spent = if self.org_day < today { 0 } else { self.org_spent };
        let org_remaining = self
            .org_daily_limit
            .saturating_sub(org_spent)
            .saturating_sub(self.org_reserved);
        let agents = self
            .agents
            .iter()
            .map(|(id, a)| {
                let spent = a.spent_on(today);
                let remaining = if a.status != AgentStatus::Active || self.org_paused {
                    0
                } else {
                    a.daily_limit
                        .saturating_sub(spent)
                        .saturating_sub(a.reserved)
                        .min(org_remaining)
                        .min(self.available)
                };
                AgentView {
                    id: *id,
                    name: a.name.clone(),
                    pk: a.pk.clone(),
                    status: a.status,
                    per_payment_limit: U128(a.per_payment_limit),
                    daily_limit: U128(a.daily_limit),
                    spent_today: U128(spent),
                    reserved: U128(a.reserved),
                    remaining_today: U128(remaining),
                    paid_count: a.paid_count,
                    rejected_count: a.rejected_count,
                    failed_count: a.failed_count,
                }
            })
            .collect();
        let merchants = self
            .merchants
            .iter()
            .map(|(account, name)| MerchantView { account: account.clone(), name: name.clone() })
            .collect();
        let pending = self
            .pending
            .iter()
            .take(MAX_VIEW_PENDING)
            .filter_map(|pid| {
                self.payments.get(pid).map(|p| PendingView {
                    payment_id: hex::encode(pid),
                    agent_id: p.agent_id,
                    merchant: p.merchant.clone(),
                    amount: U128(p.amount),
                    reserved_at_ms: p.reserved_at_ms,
                })
            })
            .collect();
        StateView {
            block_height: env::block_height(),
            timestamp_ms: env::block_timestamp_ms(),
            day: today,
            version: VERSION.to_string(),
            owner: self.owner.clone(),
            guardian_pk: self.guardian_pk.clone(),
            near: NearView {
                balance: U128(env::account_balance().as_yoctonear()),
                storage_usage: env::storage_usage(),
            },
            token: self.token.clone(),
            float_cap: U128(self.float_cap),
            available: U128(self.available),
            reserved: U128(self.reserved),
            deposited_total: U128(self.deposited_total),
            withdrawn_total: U128(self.withdrawn_total),
            paid_total: U128(self.paid_total),
            org: OrgView {
                daily_limit: U128(self.org_daily_limit),
                spent_today: U128(org_spent),
                reserved: U128(self.org_reserved),
                paused: self.org_paused,
            },
            counts: CountsView {
                paid: self.paid_count,
                failed: self.failed_count,
                rejected: self.rejected_count,
                next_seq: self.next_seq,
            },
            agents,
            merchants,
            pending,
            pending_count: self.pending.len(),
        }
    }

    pub fn outcomes(&self, from_seq: u64, limit: u32) -> OutcomesView {
        let oldest = self.next_seq.saturating_sub(RING_SIZE);
        let start = from_seq.max(oldest);
        let end = self.next_seq.min(start.saturating_add(limit.min(MAX_VIEW_OUTCOMES) as u64));
        let entries = (start..end)
            .filter_map(|seq| self.ring.get(&((seq % RING_SIZE) as u32)))
            .map(|o| OutcomeView {
                seq: o.seq,
                kind: o.kind,
                agent_id: o.agent_id,
                payment_id: hex::encode(o.payment_id),
                merchant: decode_merchant(&o.merchant),
                amount: U128(o.amount),
                reason: Reason::from_code(o.reason).map(|r| r.as_str().to_string()),
                block_height: o.block_height,
                timestamp_ms: o.timestamp_ms,
            })
            .collect();
        OutcomesView { oldest_seq: oldest, entries }
    }

    pub fn payment(&self, payment_id: String) -> Option<PaymentView> {
        let pid = parse_payment_id(&payment_id);
        self.payments.get(&pid).map(|p| PaymentView {
            agent_id: p.agent_id,
            merchant: p.merchant.clone(),
            amount: U128(p.amount),
            day: p.day,
            reserved_at_ms: p.reserved_at_ms,
            status: p.status,
        })
    }
}

// ---------- internals ----------

impl Vault {
    fn free_near(&self) -> u128 {
        let locked = (env::storage_usage() as u128).saturating_mul(env::storage_byte_cost().as_yoctonear());
        env::account_balance().as_yoctonear().saturating_sub(locked)
    }

    fn roll_org(&mut self, today: u32) {
        if self.org_day < today {
            self.org_day = today;
            self.org_spent = 0;
        }
    }

    fn agent_or_panic(&self, agent_id: u32) -> Agent {
        self.agents.get(&agent_id).cloned().unwrap_or_else(|| fail("E_ARGS", "unknown agent"))
    }

    fn auth_owner(&self) {
        if env::predecessor_account_id() != self.owner {
            fail("E_AUTH", "owner only");
        }
        if env::attached_deposit() != NearToken::from_yoctonear(1) {
            fail("E_DEPOSIT", "requires exactly 1 yoctoNEAR");
        }
    }

    /// Guardian FC key (signs as the vault) or the owner with 1 yoctoNEAR. Returns "guardian" or "owner".
    fn auth_guardian_or_owner(&self) -> &'static str {
        let pred = env::predecessor_account_id();
        if pred == env::current_account_id() && env::signer_account_pk() == self.guardian_pk {
            return "guardian";
        }
        if pred == self.owner {
            if env::attached_deposit() != NearToken::from_yoctonear(1) {
                fail("E_DEPOSIT", "requires exactly 1 yoctoNEAR");
            }
            return "owner";
        }
        fail("E_AUTH", "guardian or owner only")
    }

    fn check_allowance(allowance: U128) -> Allowance {
        if allowance.0 > MAX_AGENT_ALLOWANCE.as_yoctonear() {
            fail("E_ARGS", "allowance above 3 NEAR");
        }
        // Zero would mean an unlimited allowance at the protocol level: refuse it.
        Allowance::limited(NearToken::from_yoctonear(allowance.0))
            .unwrap_or_else(|| fail("E_ARGS", "allowance must be positive"))
    }

    fn push_outcome(
        &mut self,
        kind: OutcomeKind,
        agent_id: u32,
        pid: &[u8; 32],
        merchant: &AccountId,
        amount: u128,
        reason: Option<Reason>,
    ) -> u64 {
        let seq = self.next_seq;
        self.next_seq += 1;
        self.ring.insert(
            (seq % RING_SIZE) as u32,
            Outcome {
                seq,
                kind,
                agent_id,
                payment_id: *pid,
                merchant: encode_merchant(merchant),
                amount,
                reason: reason.map(|r| r as u8).unwrap_or(0),
                block_height: env::block_height(),
                timestamp_ms: env::block_timestamp_ms(),
            },
        );
        seq
    }
}

/// Owner-only self-upgrade. Input is the raw wasm (not JSON). One batch receipt:
/// DeployContract + FunctionCall(migrate), so a failing `migrate` reverts the deploy.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn upgrade() {
    env::setup_panic_hook();
    let this: Vault = env::state_read().unwrap_or_else(|| fail("E_STATE", "no state"));
    this.auth_owner();
    let code = env::input().unwrap_or_else(|| fail("E_ARGS", "missing wasm"));
    if code.is_empty() {
        fail("E_ARGS", "missing wasm");
    }
    let code_hash = bs58::encode(env::sha256(&code)).into_string();
    let args = json!({ "code_hash": code_hash }).to_string().into_bytes();
    Promise::new(env::current_account_id())
        .deploy_contract(code)
        .function_call_weight("migrate", args, NearToken::from_yoctonear(0), MIGRATE_GAS, near_sdk::GasWeight(1))
        .detach();
}

#[cfg(test)]
mod tests;
