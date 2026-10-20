# Vault implementation notes

Builds: `scripts/build-contracts.sh` (cargo-near 0.22, rust 1.86, near-sdk 5.27). Tests: `scripts/test-contracts.sh` (unit, then sandbox).

## Verified in sandbox (S-1, S-2, S-3 partial)

- Contract adds its own FC key (`pay`, receiver vault, limited allowance); calls signed by it see `predecessor == vault` and `signer_account_pk == key`. The tx final value is the callback's `PayResult`.
- FC key + deposit: `DepositWithFunctionCall`. Two actions: `RequiresFullAccess`. Other method: `MethodNameMismatch`. Other receiver: `ReceiverMismatch`. Deleted key: `AccessKeyNotFound`.
- Re-broadcast of identical signed bytes returns the original outcome (same hash), no new receipt.
- `ft_transfer` to an unregistered receiver fails in one receipt; the callback sees `Failed` and refunds.
- `DeleteKey` + `AddKey` of one pk in one batch works (`refill_agent_key`, `rotate_guardian`).
- `upgrade` (raw wasm input, deploy + `migrate` in one batch) works with a 278 KB wasm. A panicking `migrate` variant is not tested yet.
- In-flight (mock-ft `set_delay_hops`): a guardian pause, merchant removal or revoke landing between reservation and settlement does not stop that payment (settles `paid`); the next one is refused (T-18, T-34).
- Gas per pay (measured): pay 3.3 Tgas, ft_transfer 1.8, callback 2.7 (budget 20).

## Deviations from the spine

- **Allowance bounds in-flight txs per key.** With a 1 NEAR allowance and 60 Tgas pays, only 16 txs from one key can be in flight; extra ones are dropped before inclusion (never executed, no state change, RPC reports a timeout). Cause not confirmed (likely the protocol charging pending txs against the allowance). The spine's burst allowance of 0.25 NEAR would allow about 4 in flight. T-13 uses a burst agent with the 3 NEAR cap. SDK: keep at most 4 in flight per agent (already the plan) and treat a timeout as `unknown`, never as failure.
- `upgrade` is a raw `extern "C"` export (input = wasm bytes), owner + 1 yocto. The `upgraded {code_hash, version}` event is emitted by `migrate`, so it only appears if the deploy commits.
- `migrate(code_hash: Option<String>)` takes an optional arg (passed by `upgrade`). The "once per VERSION" guard is not implemented.
- `on_*` callbacks also require exactly one promise result (`E_AUTH` otherwise), so a direct call by any vault key cannot settle a payment.
- `register_agent` and `refill_agent_key` refuse `allowance == 0` (`E_ARGS`): zero means unlimited at the protocol level. `new` refuses `owner == vault`.
- `add_merchant` on an existing account overwrites the name; merchant name 1 to 64 bytes. `remove_merchant` of an unknown account is `E_ARGS`.
- `resume_agent` on a non-paused agent is `E_STATE`. `withdraw(0)` is `E_ARGS`.
- Owner calls with the wrong deposit panic `E_DEPOSIT` (wrong predecessor is `E_AUTH`).
- Token backing (C2/P6) `ft_balance_of(vault) >= available + reserved` holds only when nothing is pending: between a payment's `ft_transfer` and its settle callback the tokens have left while still counted in `reserved`. In-flight-safe form: `ft_balance_of >= available + (reserved - org.reserved)`. Seen on testnet with views at final.
- Lowering `daily_limit` while payments are reserved can let that day's settled total exceed the new (lower) limit, never the limit in force at reservation time.

## View shape changes (for Builder B)

- Final `state()` shape: `{block_height, timestamp_ms, day, version, owner, guardian_pk, near: {balance (U128 string, yocto), storage_usage (number)}, token, float_cap, available, reserved, deposited_total, withdrawn_total, paid_total, org: {daily_limit, spent_today, reserved, paused}, counts: {paid, failed, rejected, next_seq}, agents: [{id, name, pk, status, per_payment_limit, daily_limit, spent_today, reserved, remaining_today, paid_count, rejected_count, failed_count}], merchants: [{account, name}], pending: [{payment_id, agent_id, merchant, amount, reserved_at_ms}], pending_count}`. Amounts are U128 decimal strings; counts, ids, heights and ms are numbers.
- `state()` adds two top-level fields: `owner` (account id) and `guardian_pk` (`ed25519:...`). Everything else matches 3-contract.md.
- Events: NEP-297 `EVENT_JSON:{"standard":"orbit-vault","version":"1.0.0","event":...,"data":[{...}]}`; `data` is a one-element array. `payment_paid|failed|rejected` data: `payment_id, agent_id, merchant, amount, seq, reason` (`reason` null for paid). `deposited` data: `sender_id, accepted, refunded`.
- `payment(id)` with a malformed id panics `E_ARGS` (unknown well-formed id returns null).

## Testnet deployment (2026-10-20)

Vault `orbit-vault-fkuc.testnet`, owner `orbit-owner-fkuc.testnet`, token `orbit-token-fkuc.testnet` (otusd), merchant `orbit-merchant-fkuc.testnet`, unlisted `orbit-unlisted-fkuc.testnet`. Deploy key deleted. Guardian key file (NEAR credentials JSON, mode 600, outside the repo): `~/.near-credentials/orbit-testnet/orbit-vault-fkuc.testnet/guardian.json`, added at init with methods exactly `pause_agent,pause_all`.
