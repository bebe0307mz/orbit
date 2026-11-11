# Orbit demo: one budget, many agent keys

**One sentence:** Orbit lets an agent business pay for work through NEAR while one vault enforces agent, workspace and company spending limits across the fleet.

## Record a 90-second judge cut

| Time | Screen and action | Say |
| --- | --- | --- |
| 0–10 s | Show the Agents dashboard with separate agent keys, two workspace budgets and one organization budget. | “An agent can pay for a job, but who stops its team or the whole fleet from overspending?” |
| 10–35 s | Run `pnpm demo:agents audit --account near.testnet`. Show the HTTP 402 invoice, the agent's `pay` transaction, and the returned account data. Open the transaction link. If a live run stalls, show the [11 November verified run](evidence/testnet-fresh-audit-2026-11-11.json) and label it as recorded. | “Each agent holds a NEAR key limited to the vault's `pay` method. The merchant serves data only after it verifies the final vault payment.” |
| 35–60 s | Show the recorded live workspace burst and run `node scripts/verify-workspace-burst.mjs`. Open one paid and one rejected transaction. | “Two pay-only agent keys raced 20 payments against one $1.50 operations budget. Fifteen settled and five were rejected on testnet.” The workspace is already at its cap, so replay the recorded run rather than claiming a second fresh burst. |
| 60–80 s | In the live testnet dashboard, pause `rogue-agent`, then run `pnpm demo:attack --agent rogue-agent --once`. Show `agent_paused` in Activity. | “A separate guardian key can stop spending without being able to withdraw funds.” |
| 80–90 s | Show the public repository's evidence index and the one-line status. | “The vault and 402 purchase work on testnet. The Agent Market seller worker is built, but a real marketplace assignment has not yet been completed.” |

Use the version 1.1 testnet vault and open-mint test token (`otusd`, no monetary value). The paid diagnostic reads public NEAR RPC data; the synthetic quote endpoint should not appear in the hero clip. The workspace burst is a separate live testnet run, and the original organization-wide four-agent race remains a local sandbox run. Label their dates and environments.

## Prepare before recording

1. Follow [README.md](README.md#reproduce-on-testnet) to run the merchant, dashboard and testnet vault. Run `pnpm demo:agents market-check` separately if showing the private Agent Market draft; this is a read-only preflight, not a completed job.
2. Keep the keychain, key files, credentials, account setup commands, and browser tabs containing secrets off screen. Use a clean browser profile and crop terminal prompts before publishing.
3. Preload the dashboard and the exact testnet transaction explorer page. Record the transaction hash and payment ID so a judge can verify them from the repository's [evidence index](evidence/README.md).
4. Rehearse twice with a stopwatch. Use captions for `402 → pay → 200`, `15 paid / 5 workspace rejections`, and `guardian pause` so the story works without sound.
5. Record one continuous run of each proof. Edit for pace, and label any earlier recorded evidence with its date. If a live transaction stalls, show its final status only after it resolves; do not imply a pending payment settled.

## If a real Agent Market job lands before submission

Replace the first purchase scene with the actual buyer assignment → seller's Orbit expense → final diagnostic → marketplace submission. Show the assignment ID, Orbit payment ID, testnet transaction hash, and marketplace submission receipt together. Confirm all four before calling the marketplace workflow live. The seller draft must remain unpublished until the team approves publication.

## Public demo post draft for the human to publish

> AI agents can spend faster than an operator can review every payment. We built Orbit at NEAR HACKATHON: one vault gives each agent a pay-only key and enforces agent, workspace and company budgets. An agent buys data through HTTP 402. Then two agent keys race 20 testnet payments against one workspace cap: 15 settle, five are rejected. All transactions are public. Test tokens have no value. Demo: [video] Code: [public repo]. @NEARProtocol #NEARHackathon

Replace the placeholders and have a human publish the post. The public post and public repository are submission requirements in the [official guidance](https://nearhackathon.com/HACKATHON.md). Recheck that guidance before submitting.
