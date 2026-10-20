# Orbit

Orbit is a shared spending vault for fleets of AI agents on NEAR. One contract holds USDC. Each agent gets its own NEAR function-call key that can call exactly one method, `pay`. The contract enforces a per-payment limit, a per-agent daily limit, an org-wide daily limit, a merchant allowlist and replay protection, and a separate pause-only guardian key can stop one agent or all of them. A two-screen dashboard reads the vault's real state.

Status: hackathon MVP, running on NEAR testnet with a test token (`otusd`, no value). Mainnet is not deployed.

## The problem

An agent that pays for APIs needs spending authority. Giving it a wallet key means a prompt-injected or compromised agent can spend everything the key controls. Limits kept in an off-chain service can be raced: many concurrent requests can pass a check before any of them is counted. A fleet also needs one budget across all agents, and a way to stop an agent in seconds without handing that power to the same server that could be compromised.

Orbit puts every limit inside one NEAR contract. Each payment is checked and reserved in a single receipt, so the limits hold under any concurrency. On testnet, 20 simultaneous $0.05 payments from one agent against a $0.25 daily limit give exactly 5 paid and 15 rejected.

## NEAR features used

- **Function-call access keys, one per agent.** The vault adds each agent's key to its own account with the method list exactly `["pay"]`, receiver the vault and a limited NEAR allowance. The protocol refuses any other method (`MethodNameMismatch`), any deposit (`DepositWithFunctionCall`) and any other receiver. The contract identifies the agent by `env::signer_account_pk()`.
- **A pause-only guardian key.** A second function-call key with methods exactly `pause_agent,pause_all`, held by the dashboard server. It cannot resume, withdraw, change limits or upgrade.
- **NEP-141 USDC.** The owner deposits with `ft_transfer_call`; `ft_on_transfer` credits only the owner and only the pinned token, clamped to a float cap, and the excess is refunded by NEP-141. Payments use `ft_transfer` with a settle callback that refunds on failure.
- **NEP-297 events** (`orbit-vault` 1.0.0) for every reservation, payment, rejection and admin action.
- Access-key nonces stop re-broadcast of a signed transaction; a stored `payment_id` stops a second payment for one invoice.

## Architecture

```
owner (founder machine, full-access key)  --orbit-cli, 1 yocto-->  vault contract (contracts/vault)
agent host: agent key (pay only) + orbit-agent SDK  --pay tx-->      vault: checks, reserves, ft_transfer, settles
vault  --ft_transfer-->  USDC (NEP-141)  -->  merchant account
agent  --HTTP 402 / X-PAYMENT-->  services/merchant  --view payment(id) at final-->  vault
services/api: syncer (state(), outcomes()), SQLite history, guardian pause signer  -->  apps/dashboard
demo/agents: four scripted agents on the SDK;  demo/attack: rejection, replay and burst demonstrations
```

Policy checks, in order: duplicate payment id, deadline, org paused, agent paused, merchant allowlist, per-payment limit, agent daily limit, org daily limit, vault balance. A rejection does not panic: it is written to a 256-entry outcome ring with a reason code and returned to the agent, so the dashboard can show it.

## Orbit and OutLayer

OutLayer (a hackathon partner) offers TEE-held, multi-chain agent wallets with a rich policy engine, multisig and mainnet maturity. Its documentation describes cumulative caps as best-effort under concurrency. Orbit is a narrower budget layer that can sit beside such a wallet: limits are exact because they are contract state checked and reserved in one receipt, one treasury serves many agents under an org-wide cap, the pause key is separate from the owner, and merchants verify payments from contract state. Orbit does not do multi-chain, swaps or multisig, and an Orbit agent key is a real secret on the agent's host, bounded only by its limits.

## Repository

| Path | What |
|---|---|
| `contracts/vault` | The vault contract (Rust, near-sdk 5.27), unit tests, `NOTES.md` (deviations, view shapes, mainnet checklist) |
| `contracts/mock-ft` | `otusd` test token (NEP-141) with owner mint and test switches |
| `contracts/sandbox` | Sandbox integration harness (near-workspaces, real receipts) |
| `packages/orbit-agent` | Agent SDK: key generation, `pay()`, `orbitFetch()` for HTTP 402 |
| `packages/vault-types` | Shared view and API types |
| `services/merchant` | Demo paid data API (synthetic data) that verifies payments on chain |
| `services/api`, `apps/dashboard` | Read API, history, guardian pause, two-screen dashboard |
| `tools/orbit-cli` | Owner commands |
| `demo/agents`, `demo/attack` | Demo fleet and attack script |
| `scripts/` | Contract build, contract tests, testnet proof |

## Reproduce on testnet

Prerequisites: Rust via rustup (the repo pins 1.86.0 with `wasm32-unknown-unknown`), `cargo install cargo-near` (0.22), [near-cli-rs](https://github.com/near/near-cli-rs) (`near`, 0.30), Node 22, pnpm 9. Everything below uses testnet only and a test token.

### 1. Install and build

```bash
git clone <repo> orbit && cd orbit
pnpm install
scripts/build-contracts.sh
```

See: `Binary: .../target/near/mock_ft/mock_ft.wasm` and `Binary: .../target/near/orbit_vault/orbit_vault.wasm`. The script also keeps two variants next to it: `orbit_vault_mainnet.wasm` (pins Circle USDC, float cap at most 20 USDC) and `orbit_vault_migrate_panic.wasm` (test only).

### 2. Run the tests

```bash
cargo test -p orbit-vault --lib            # see: test result: ok. 22 passed
cargo test -p orbit-sandbox-tests --test sandbox -- --nocapture   # see: VERDICT: PASS 22, FAIL 0, SKIP 1
pnpm test                                  # TypeScript suites (SDK, merchant, CLI, API, dashboard)
```

The sandbox run downloads a local nearcore binary on first use and takes about 6 minutes. It prints one row per scenario, for example `T-13  I1 burst  PASS ... 5 paid {1: 5}, rejected {"over_agent_daily_limit": 15}`. `ORBIT_MIDNIGHT=1` adds the midnight test (it fast-forwards the chain to the next UTC midnight, 5 to 40 minutes).

### 3. Create testnet accounts

Pick a suffix `<s>` and create five accounts with the faucet (each gets 10 testnet NEAR):

```bash
for n in owner vault token merchant unlisted; do
  near account create-account sponsor-by-faucet-service orbit-$n-<s>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
done
chmod 600 ~/.near-credentials/testnet/orbit-*-<s>.testnet.json ~/.near-credentials/testnet/orbit-*-<s>.testnet/*.json
```

See: `New account <orbit-owner-<s>.testnet> created successfully.` five times. The SDK and CLI refuse key files readable by others, hence the `chmod`.

Then set the environment (keep it outside the repo):

```bash
export NEAR_NETWORK=testnet NEAR_RPC_URL=https://rpc.testnet.fastnear.com,https://rpc.testnet.near.org
export VAULT_ACCOUNT_ID=orbit-vault-<s>.testnet OWNER_ACCOUNT_ID=orbit-owner-<s>.testnet TOKEN_ACCOUNT_ID=orbit-token-<s>.testnet
export MERCHANT_ACCOUNT_ID=orbit-merchant-<s>.testnet UNLISTED_ACCOUNT_ID=orbit-unlisted-<s>.testnet
export ORBIT_KEY_DIR=$HOME/.near-credentials/orbit-testnet/$VAULT_ACCOUNT_ID
```

### 4. Deploy the token and the vault

```bash
CLI=tools/orbit-cli/orbit-cli
$CLI token-deploy --network testnet --yes
GUARDIAN_PK=$(node --experimental-strip-types --no-warnings packages/orbit-agent/src/cli.ts keygen --out $ORBIT_KEY_DIR/guardian.json --vault $VAULT_ACCOUNT_ID)
$CLI deploy --network testnet --guardian-pk $GUARDIAN_PK --float-cap 20 --org-daily 5 --yes
```

See, in order: `OK deploy+new`, `OK storage_deposit(vault)`, `OK delete deploy key`, `code_hash ... match`, then the status checks `OK C1 conservation (I7)`, `OK C2 token backing`, `OK C3 counters (I9)`, `OK C5 keys (I11): 1 keys`. After this the vault account has no full-access key; it holds only the guardian key.

Without `--yes` every command prints the decoded call and waits for you to type `yes`.

### 5. Merchant, funds and agents

```bash
$CLI storage-deposit --network testnet --account $MERCHANT_ACCOUNT_ID --yes
$CLI add-merchant --network testnet --account $MERCHANT_ACCOUNT_ID --name orbit-data --yes
$CLI token-mint --network testnet --amount 25 --yes
$CLI deposit --network testnet --amount 25 --yes
pnpm demo:agents keys --register
```

See: `OK storage_deposit`, `event merchant_added`, then `accepted $20.00 (20000000 base units), refunded $5.00 (5000000 base units)` (the float cap is 20), then four `event agent_registered` lines each followed by `key ed25519:...: FunctionCall(<vault>, [pay], allowance ...) (I11 ok)`. `add-merchant` refuses an account not registered on the token, because payments to it would fail.

### 6. Pay through HTTP 402

Terminal 1:

```bash
pnpm merchant
```

See: `{"msg":"merchant_listening","port":8402,"demo":true}`. `curl -i localhost:8402/v1/quote?symbol=NEAR` returns `HTTP/1.1 402` with a JSON invoice (`"scheme":"orbit-near"`, `payment_id`, `amount`, `deadline_ms`).

Terminal 2:

```bash
MERCHANT_URL=http://127.0.0.1:8402 pnpm demo:agents run --minutes 2
```

The four agents request quotes, pay the 402 invoices through the vault and print their outcomes; each paid line carries a `https://testnet.nearblocks.io/txns/<hash>` link. The merchant serves a quote only after `payment(id)` at final shows `paid` for that merchant and amount, the invoice is unused, and the proof is signed by the paying agent's key.

### 7. Attack

```bash
pnpm demo:attack --agent research-scout
pnpm demo:attack --burst
```

See, for `--agent`:

```
1. pay $0.50 (over its per-payment limit)    rejected over_per_payment_limit seq ...
2. pay orbit-unlisted-<s>.testnet (not allowlisted) rejected merchant_not_allowed seq ...
3. replay paid payment_id ...                rejected duplicate_payment seq ...
4. rebroadcast identical signed tx 3         RPC returned the original outcome of <hash> (same tx, no new receipt); vault counters unchanged
```

For `--burst` (registers a fresh agent with a $0.25 daily limit and a 3 NEAR key allowance): 20 lines, then `burst result: 5 paid, 15 over_agent_daily_limit`. Each run writes `harness/out/testnet-attack-<utc>/summary.json` with the checks and transaction links.

### 8. Pause from the dashboard

```bash
$CLI hash-password          # type a password, copy the scrypt$... line
pnpm --filter @orbit/dashboard build
GUARDIAN_KEY_FILE=$ORBIT_KEY_DIR/guardian.json OPERATOR_PASSWORD_HASH='<scrypt line>' SESSION_SECRET=$(openssl rand -hex 32) pnpm api
```

Open http://localhost:8787. The Agents screen shows every agent with its limits, spent today and remaining, read from one `state()` snapshot; Activity lists paid, failed and rejected outcomes with reason codes. Sign in, pause an agent: the row shows `Pausing` until the chain confirms, then `Paused`. Then `pnpm demo:attack --agent research-scout --once` prints `rejected agent_paused`. Resuming needs the owner: `$CLI resume-agent --network testnet --agent <id>`.

### 9. Check the books

```bash
$CLI status --network testnet
```

See: every agent with limits and spending, and `OK` on C1 (deposited equals available plus reserved plus paid plus withdrawn), C2 (the vault's token balance backs it), C3 (outcome counters), C5 (the vault's key list is exactly the guardian plus one `pay` key per live agent) and free NEAR.

`scripts/testnet-proof.sh` runs the same story non-interactively (deploy with near-cli, payments, rejections, guardian pause, accounting and key checks) and writes `harness/out/testnet-<utc>/summary.json`. `pnpm harness` builds a static HTML report from all test layers and proofs.

## Security model in brief

- The owner key (founder machine only) can do everything, including `upgrade`; the float cap keeps the vault small (20 USDC on mainnet).
- A stolen agent key can spend at most that agent's remaining limits per UTC day, inside the org limit, only to allowlisted merchants, until it is paused or revoked. Its NEAR allowance bounds the gas it can burn.
- A stolen guardian key can only pause.
- Known limits: a 24 hour window that spans UTC midnight can see up to two days of one agent's limit; a settle callback that fails leaves the payment reserved until an `upgrade` repairs it. Details: `contracts/vault/NOTES.md`.
