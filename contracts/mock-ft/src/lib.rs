//! Orbit test token (`otusd`). TEST TOKEN ONLY, no value.
//!
//! Reference NEP-141 + NEP-145 from near-contract-standards, 6 decimals,
//! owner-only `mint`. `set_fail_transfers(true)` makes every `ft_transfer`
//! panic (owner-only), so tests can exercise the vault refund path with a
//! registered receiver.

use near_contract_standards::fungible_token::events::FtMint;
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue};

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Token,
}

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct MockFt {
    owner: AccountId,
    token: FungibleToken,
    symbol: String,
    fail_transfers: bool,
}

#[near]
impl MockFt {
    #[init]
    pub fn new(owner: AccountId, symbol: Option<String>) -> Self {
        let mut this = Self {
            owner: owner.clone(),
            token: FungibleToken::new(StorageKey::Token),
            symbol: symbol.unwrap_or_else(|| "OTUSD".to_string()),
            fail_transfers: false,
        };
        this.token.internal_register_account(&owner);
        this
    }

    /// Owner-only mint. Registers the receiver if needed (owner pays nothing extra:
    /// the token account covers that storage, acceptable for a test token).
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        if !self.token.accounts.contains_key(&account_id) {
            self.token.internal_register_account(&account_id);
        }
        self.token.internal_deposit(&account_id, amount.0);
        FtMint { owner_id: &account_id, amount: amount.into(), memo: Some("otusd test mint") }.emit();
    }

    /// Owner-only toggle: when true every `ft_transfer` and `ft_transfer_call` panics.
    pub fn set_fail_transfers(&mut self, fail: bool) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        self.fail_transfers = fail;
    }

    pub fn owner(&self) -> AccountId {
        self.owner.clone()
    }
}

#[near]
impl FungibleTokenCore for MockFt {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        require!(!self.fail_transfers, "mock-ft: transfers disabled");
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(!self.fail_transfers, "mock-ft: transfers disabled");
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for MockFt {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let (used, _burned) = self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        used.into()
    }
}

#[near]
impl StorageManagement for MockFt {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.internal_storage_unregister(force).is_some()
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for MockFt {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Orbit Test USD (test token, no value)".to_string(),
            symbol: self.symbol.clone(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 6,
        }
    }
}
