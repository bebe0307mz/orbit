# Orbit — treasury controls and purchased work

[Watch the 60-second product demo](evidence/demo.mp4). The application opens directly into treasury controls. The video explains selected interactions; it is a separate artifact.

## Run the product

```sh
pnpm install --frozen-lockfile
VITE_SOURCE=rpc VITE_NETWORK=testnet VITE_ORG_NAME=Orbit VITE_VAULT_ACCOUNT_ID=orbit-ws-11a7-vault.testnet pnpm --filter @orbit/dashboard build
pnpm --filter @orbit/dashboard preview --host 127.0.0.1 --port 5185 --strictPort
```

Open http://127.0.0.1:5185. No credentials are needed for this public read-only view. The header distinguishes **Live RPC**, **Testnet · test token** and **Read only**.

## Useful tasks

1. **Understand exposure:** available funds, organization/workspace limits, in-flight amounts and individual agent authority are the primary screen. **Emergency pause** is visibly unavailable in direct-RPC mode. The authenticated guardian API supports the actual pause dialog; this walkthrough sends no pause.
2. **Review work bought:** open **Transactions → Paid**, expand the 11 November 08:18 `research-scout` payment (#21, $0.01 test tokens), then **Open account report**. Four keys could fully control `near.testnet` at the recorded delivery block. The report advises confirming custody; it does not claim a compromise.
3. **Check current data and export:** **Refresh live account data** performs a free public read, separately labeled from the recorded paid delivery. **Download report** exports the inventory and both provenance labels as JSON. If RPC fails, the last report remains visible with an error.
4. **Investigate blocked spending:** choose **Rejected**, expand a `price-watcher` workspace-cap rejection (#20), and follow its exact public receipt. The useful paid diagnostic and the workspace burst are separate recorded examples, not one newly executed job.
5. **Monitor agents:** choose **Workspace** beside the normal agent table. Characters show real key/paused/pending state and dated last outcomes. Idle is not presented as a running autonomous job. Click a character for permissions/limits or open **Activity & purchased work**. Search selects other agents; Table remains the default.
6. **Optional stress proof:** the **Example & evidence** disclosure below the controls contains the recorded 20-request workspace test: 15 paid, five cap-blocked. It is not the home screen or a live payment launcher.

## Evidence boundaries

- The [paid task](evidence/testnet-fresh-audit-2026-11-11.json) records HTTP 200 at block **277189529**. Its original HTTP body was not preserved. The displayed [report](evidence/paid-task-report-2026-11-14.json) was reconstructed from public archival account/key data at that exact block and is explicitly labeled. A live refresh is a separate current read, not a new paid task.
- [Paid task transaction](https://testnet.nearblocks.io/txns/FSaoxkDUWe1naQjCvkJAdhiELbPfsKokM8vNiMJRhuF4) · [workspace rejection](https://testnet.nearblocks.io/txns/DHfjEfbdSEdz8ZbwYyfiAcPt5ea82V7RcBT6Ed1E3ayT). The execution of `pay` succeeds by returning a policy rejection; that does not mean payment tokens were transferred.
- Recorded vault: `orbit-ws-11a7-vault.testnet`. Recorded token: `orbit-ws-11a7-token.testnet`. All dollar signs are **no-value test-token units**.
- The [20-payment operations burst](evidence/testnet-workspace-burst-2026-11-11.json) settled 15 and blocked five. The separate sandbox fleet test is **5 paid / 15 blocked**. Submission-overlap timing is not independently reconstructed; animation timing is illustrative.
- Current totals include 23 outcomes (17 paid, six rejected), two diagnostics and a guardian rejection. Daily budgets reset at UTC midnight, so current amounts differ from historical results.
- Direct RPC does not index transaction hashes. A saved link appears only when the network, vault and all nine outcome fields match. Unknown outcomes retain the block fallback.
- The diagnostic is operator-run and uses public data. No live marketplace assignment, third-party paid-data adoption, mainnet deployment or production security certification is established.

```sh
node scripts/verify-paid-task-report.mjs
node scripts/verify-recorded-receipts.mjs
node scripts/verify-workspace-burst.mjs
node scripts/verify-guardian-pause.mjs
```

These are read-only archival RPC checks and exit nonzero on unavailable or mismatched evidence. `ORBIT_RPC` overrides the endpoint. No new payment is needed.

## Final narration and edit map

| Time | Actual picture / action | Zoe QUICK narration |
|---|---|---|
| 0.0–7.9s | Original short problem slide, separate from the working product. | Your agents need tools to finish their work. Give the team a shared budget without giving every agent unrestricted access to company funds. |
| 7.9–15.6s | Transactions → Paid → expand the recorded research-scout payment #21. | Here, research-scout paid one cent in no-value test tokens for an account access check. Open the report to see the useful result. |
| 15.6–25.3s | Open purchased account report: four full-control keys; reconstructed saved-block provenance visible. | Four keys could fully control this account. Confirm who holds each one. This report was reconstructed from the saved delivery block; the original response wasn’t preserved. |
| 25.3–32.6s | Genuine live public account refresh; saved payment remains separate. Actual JSON download was verified. | Refresh current data without paying again, then download the report. This is a live public read, separate from the recorded purchase. |
| 32.6–41.4s | Switch to Rejected → expand the separate recorded workspace-cap rejection #20. | In a separate recorded run, another agent’s request hit the shared workspace cap. The owner gets useful work while the budget stops further spending. |
| 41.4–50.5s | Optional Example & evidence disclosure → recorded20-request proof;15 paid,5 blocked. No new payment. | The supporting twenty-request test settled fifteen payments and blocked five. NEAR enforces one shared limit, using pay-only agent keys. |
| 50.5–60.3s | Optional workspace monitor: click character to inspect actual spending authority, then return. Idle is genuine; last outcomes are dated. Closing slide is original video material. | Orbit is a testnet prototype for teams buying services with NEAR. Today, review the work, its cost, and the budget protection. Real merchant adoption is still needed. |

## Production and checks

60-second, 1920×1080, 30 fps MP4 with authorized Zoe QUICK narration and ordinary synchronized [subtitles](evidence/demo.srt). Short original problem/closing slides are video-only. Product footage uses close-up browser views; genuine network waits were trimmed. There is no redundant provenance footer.

A fresh source snapshot with no copied dependency directory installed the frozen lockfile from cached registry packages, passed **240 TypeScript tests** (three external transaction tests skipped), and built the dashboard. Dashboard has **42 tests**; merchant has **23 passing tests**, including the real HTTP/SDK delivery followed by a fixture cap rejection. That regression is not a new chain transaction; real shared-cap enforcement has separate Rust/sandbox evidence. Three build-script failure regressions and all 60 contrast pairs passed. The inspected saved Rust unit run passed 27 tests.

Desktop task checks used a 1280px app iframe and keyboard navigation; phone task checks used a real 390px app iframe. Both exposed exact payment details. Phone opened the purchased report without horizontal body overflow. Live refresh and the actual downloaded JSON were verified. Public RPC can be intermittent; unknown history no longer masquerades as an empty match.

The corrected contract build script also compiled all four local WASM variants. The fresh testnet vault artifact matches the deployed code hash at final block 277661489. The [production manifest](evidence/production-manifest-2026-11-14.json) records hashes and tool versions. This is a local cargo-near build, not a reproducible container build or mainnet release qualification.
