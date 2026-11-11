# Orbit progress — 11 November 2026

This is a factual build status, not a hackathon strategy document.

## Verified

- Version 1.0 testnet vault: final HTTP 402 purchase, matching vault and token events, and current pay-only key permissions. Run `node scripts/verify-public-proof.mjs` to recheck public RPC state.
- Original sandbox: 20 concurrent payments from four agents against one organization cap; 5 paid, 15 rejected. See `evidence/sandbox-shared-cap-t14b.json`.
- Version 1.1 local tests: workspace limits, four-agent reservation burst, failed-transfer refund across all budget levels, owner-only workspace controls. `cargo test -p orbit-vault --lib` passed 27 tests on 11 November.
- CLI, demo-agent, dashboard and API type checks passed after the workspace change; CLI, demo-agent and dashboard tests passed.

## In progress

- Fresh version 1.1 testnet vault deployment with two workspaces and live payment evidence.
- Full sandbox and end-to-end dashboard checks against the new vault.
- Three-minute public demo capture and submission content.

## Not demonstrated

- A real NEAR Agent Market buyer assignment and seller payout. The draft remains unpublished.
- Production-value USDC or mainnet payments. The testnet token is open-mint and valueless.
- x402 v2 `exact` compatibility. The merchant uses its documented `orbit-near` 402 scheme.
- Commercial demand for the paid diagnostic; its underlying account data come from public RPC.

## Deployment boundary

Version 1.1 adds Borsh fields to the vault and agent records. It is intended for a fresh testnet account. The original version 1.0 account and its public transaction remain untouched; its older evidence does not prove the workspace feature.
