# Orbit — treasury controls and purchased work

[Watch the 81-second product walkthrough](evidence/demo.mp4). The application opens directly into treasury controls. The video explains selected interactions; it is a separate artifact.

Public read-only app: https://orbit-agent-treasury.lunarmouse9.chatgpt.site . [Public video](https://orbit-agent-treasury.lunarmouse9.chatgpt.site/demo.mp4) · [subtitles](https://orbit-agent-treasury.lunarmouse9.chatgpt.site/demo.srt).

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

## Natural product walkthrough

The [81-second main video](evidence/demo.mp4) keeps the real desktop app visible from the first frame. At 1280×720, the agent table, shared budgets and docked agent controls can be compared together. It follows one investigation through actual scrolling and clicks, with pauses to read the result. The [26-second silent mobile treasury scroll](evidence/mobile-treasury-scroll.mp4) is supplementary responsive footage, not a second complete task demo.

| Time | Actual app interaction | Spoken explanation |
|---|---|---|
| 0–15s | Treasury loads from public RPC; available funds and shared budgets remain visible. | Agents need to buy data and tools. Orbit puts one shared budget on NEAR, enforced by the contract. |
| 15–24s | Scroll the real treasury into its agent table. | Review available funds, today’s allowance and the agents sharing it. |
| 24–36s | Select research-scout; scroll its docked detail through limits, pay-only scope and recent payments. | Its key can request payments only, within per-payment, agent and workspace limits. |
| 36–60s | Follow the agent’s activity, choose Paid, expand recorded payment#21, open its account report, scroll the actual result and open its source disclosure. | The agent paid one cent in test tokens to check access keys for near.testnet. Four keys had full control, like administrator credentials; the account owner should confirm their holders. The historical report was rebuilt because the original response was not saved. |
| 60–72s | Return to all Activity, filter Rejected, expand the separate recorded operations-workspace rejection#20 and scroll its actual reason. | The shared workspace cap rejected this distinct request; no payment tokens went out. |
| 72–81s | Return to treasury funds and workspace limits. | Useful work and a shared spending boundary, using no-value test tokens on NEAR testnet. |

The paid diagnostic and blocked operations request are separate recorded cases. This is current read-only inspection; the video performs no fresh purchase or pause. The optional race is not needed to complete the walkthrough.

## Production and checks

1920×1080, 30fps H264/AAC with authorized Zoe QUICK narration and ordinary synchronized [subtitles](evidence/demo.srt). The original motion timing is preserved. Only visually unchanged waits were shortened, and every complete voice take is retained. Agent-panel and mobile scrolling use smaller genuine wheel movements with reading pauses. There are no explanatory slides, simulated scrolling, screenshot pans or invented successful operations. The real app occupies nearly the full frame. The source capture used the same production HTML/JS/CSS files on a local QA port, with the same public RPC configuration.

The actual encoded MP4 was checked at 15 timestamps, fully decoded, and compared with the final narration using automated speech recognition. Audio levels were measured. Source screenshot sampling is about10–15fps; repeated frames form the30fps export. This is not native30fps screen recording; no synthetic scrolling or optical-flow interpolation is used. No independent human listening review is claimed. The [production manifest](evidence/production-manifest-2026-11-14.json) records exact media hashes and verification scope.

A fresh source snapshot with no copied dependency directory installed the frozen lockfile from cached registry packages, passed **240 TypeScript tests** (three external transaction tests skipped), and built the dashboard. Dashboard has **42 tests**; merchant has **23 passing tests**, including the real HTTP/SDK delivery followed by a fixture cap rejection. That regression is not a new chain transaction; real shared-cap enforcement has separate Rust/sandbox evidence. Three build-script failure regressions and all 60 contrast pairs passed. The inspected saved Rust unit run passed 27 tests.

Desktop task checks used a 1280px app iframe and keyboard navigation; phone task checks used a real 390px app iframe. Both exposed exact payment details. Phone opened the purchased report without horizontal body overflow. Live refresh and the actual downloaded JSON were verified. Public RPC can be intermittent; unknown history no longer masquerades as an empty match.

The corrected contract build script also compiled all four local WASM variants. The fresh testnet vault artifact matches the deployed code hash at final block 277661489. The [production manifest](evidence/production-manifest-2026-11-14.json) records hashes and tool versions. This is a local cargo-near build, not a reproducible container build or mainnet release qualification.
