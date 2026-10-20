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

## Mainnet readiness checklist (nothing deployed)

Must be true first:
- [ ] `scripts/test-contracts.sh` green (22 unit, sandbox PASS 22 FAIL 0), plus `ORBIT_MIDNIGHT=1` sandbox T-12 green once (passed 2026-10-20: P1 reserved 2.5 s before UTC midnight, settled 0.3 s after, committed to d+1).
- [ ] Testnet: `scripts/testnet-proof.sh` and `pnpm demo:attack --agent <name>` / `--burst` green on a vault deployed from the same commit (the fkuc testnet vaults run an earlier build, code_hash `4LRJE2Wt...`).
- [ ] Mainnet build: `scripts/build-contracts.sh` writes `target/near/orbit_vault/orbit_vault_mainnet.wasm` (`--features mainnet`; sandbox MAINNET-GUARD checks it). That build pins Circle USDC `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` and refuses `float_cap > 20 USDC` in `new`. Record its sha256 and base58 code hash in the README before deploying.
- [ ] Circle USDC behavior (E4, S-2 mainnet): one tiny payment to a merchant that is not registered on USDC must settle `failed:transfer_failed` with a full refund. Do it once, right after deploy, with an extra demo agent and merchant you then remove.
- [ ] Guardian key generated on the API VM (`pnpm api keygen`); only its public key comes to the founder machine.
- [ ] Demo copy updated: a re-broadcast returns the original outcome, it is not "refused by RPC".

Accounts (founder creates):
- `orbit-vault.<team>.near`, funded with 10 NEAR, with one full-access deploy key K0 on the founder machine.
- Owner `<founder>.near` (full-access key on the founder machine): about 1 NEAR for gas and storage deposits, plus the USDC float.
- Merchant `orbit-data.<team>.near` (Orbit-run), and `unlisted-shop.<team>.near` (never allowlisted), each about 0.1 NEAR.

NEAR budget for the vault account (measured on testnet unless noted):
| Item | NEAR |
|---|---|
| Code (278 KB) plus state at init (ring, about 328 KB total) | 3.3 locked |
| Each reserved payment, kept forever | 0.0013 |
| `pay` refuses below this free balance (`STORAGE_FLOOR`) | 0.5 |
| Gas actually burnt per pay (charged to the vault, bounded by the key allowance) | about 0.0007 |
| Concurrent pays are pre-charged against the allowance and the vault balance until they settle: a 20-payment burst needs a 3 NEAR allowance (1 NEAR allows about 16) and that much free vault NEAR at that moment | up to 3 |
| Margin | 2 |
Total: 10 NEAR covers 4 demo agents (1 NEAR allowance each), one burst at a time (3 NEAR allowance) and about 1,000 payments. Allowances are caps, not locked funds; `refill-agent` renews them.

USDC: 25 USDC to the owner. The first deposit of 25 proves the clamp (20 accepted, 5 refunded, T-27). Demo spend: a burst agent spends exactly $0.25; the `harness:mainnet` list about $0.95.

What the founder signs, in order (all from the founder machine, `ORBIT_ALLOW_MAINNET=1`, each prints the decoded call and waits for `yes`):
1. `orbit-cli deploy --network mainnet --wasm target/near/orbit_vault/orbit_vault_mainnet.wasm --guardian-pk <pk from VM> --float-cap 20 --org-daily 5` signs with K0: deploy + `new` (one tx), then the owner signs `storage_deposit(vault)` on USDC, then K0 signs `DeleteKey(K0)`. Check: `code_hash ... match`, key list = guardian only, status all `OK`.
2. `orbit-cli storage-deposit --account orbit-data.<team>.near` (owner, if the merchant is not registered on USDC yet).
3. `orbit-cli add-merchant --account orbit-data.<team>.near --name orbit-data` (refuses an account not registered on USDC).
4. `orbit-cli register-agent --name <n> --public-key <pk> --daily 1 --per-payment 0.10 --allowance 1` for the 4 demo agents; burst agents `--daily 0.25 --per-payment 0.10 --allowance 3`, one fresh agent per burst run. Each checks the new key is FunctionCall(vault, ["pay"]).
5. `orbit-cli deposit --amount 25` (`ft_transfer_call` on USDC, 1 yocto): expect accepted 20, refunded 5.
6. `orbit-cli status --network mainnet`: C1, C2, C3, C5 and free NEAR all `OK`. Publish the code hash, wasm sha256, build command, init args and tx hashes.

After deploy: `services/api` starts with the guardian key and checks it is exactly `pause_agent,pause_all`; the owner fallback for a failed UI pause is `orbit-cli pause-agent --network mainnet --agent <id>`. No `upgrade` after day 13 12:00 UTC.
