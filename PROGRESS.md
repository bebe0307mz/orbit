# Orbit progress — 11 November 2026

This is a factual build status, not a hackathon strategy document.

## Verified

- Version 1.0 testnet vault: final HTTP 402 purchase, matching vault and token events, and current pay-only key permissions. Run `node scripts/verify-public-proof.mjs` to recheck public RPC state.
- Original sandbox: 20 concurrent payments from four agents against one organization cap; 5 paid, 15 rejected. See `evidence/sandbox-shared-cap-t14b.json`.
- Version 1.1 local tests: workspace limits, four-agent reservation burst, failed-transfer refund across all budget levels, owner-only workspace controls. `cargo test -p orbit-vault --lib` passed 27 tests on 11 November.
- CLI, demo-agent, dashboard and API type checks passed after the workspace change; CLI, demo-agent and dashboard tests passed.
- Version 1.1 testnet vault `orbit-ws-11a7-vault.testnet`: code hash matched the local build; two owner-created workspaces, five restricted agent keys and 20 open-mint test tokens were provisioned. A final 402 purchase from the research workspace and matching token transfer passed `node scripts/verify-public-proof.mjs evidence/testnet-workspace-audit-2026-11-11.json`.
- Live operations-workspace burst: two keys submitted 20 concurrent $0.10 payments; 15 paid, five were rejected by the $1.50 workspace cap, and the merchant received exactly 1.50 test tokens. `node scripts/verify-workspace-burst.mjs` passed against public final RPC transactions and events.
- The API migrated its SQLite outcome constraint without losing existing rows and synced the version 1.1 testnet vault: 16 paid, five rejected, no gap, and database counts match the vault. API migration and integration tests passed 41/41.
- The version 1.1 RPC and API dashboards passed 73 live-vault checks after the independent expected-value formula was updated for workspace limits. The operations workspace is exhausted; its three agents correctly show $0.00 spendable and a workspace-cap label. See [dashboard evidence](evidence/testnet-dashboard-2026-11-11.json).
- A fresh 11 November research-agent account diagnostic crossed HTTP 402 → vault payment → HTTP 200. Independent public RPC verification passed for its signed pay-only transaction, final vault event and test-token transfer. See [fresh audit](evidence/testnet-fresh-audit-2026-11-11.json).

## In progress

- Three-minute public demo capture and submission content.

## Not demonstrated

- A real NEAR Agent Market buyer assignment and seller payout. The draft remains unpublished.
- Production-value USDC or mainnet payments. The testnet token is open-mint and valueless.
- x402 v2 `exact` compatibility. The merchant uses its documented `orbit-near` 402 scheme.
- Commercial demand for the paid diagnostic; its underlying account data come from public RPC.

## Deployment boundary

Version 1.1 adds Borsh fields to the vault and agent records. It is intended for a fresh testnet account. The original version 1.0 account and its public transaction remain untouched; its older evidence does not prove the workspace feature.
