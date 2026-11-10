# Orbit demo: one budget, many agent keys

**One sentence:** Orbit lets an agent business pay for work through NEAR while one on-chain vault enforces a shared spending limit across its agents.

## Record a 90-second judge cut

| Time | Screen and action | Say |
| --- | --- | --- |
| 0–10 s | Show the Agents dashboard with four separate agents and one organization budget. | “An agent can pay for a job, but who stops a whole fleet from overspending the same budget?” |
| 10–35 s | Run `pnpm demo:agents audit --account near.testnet`. Show the HTTP 402 invoice, the agent's `pay` transaction, and the returned account data. Open the transaction link. | “Each agent holds a NEAR key limited to the vault's `pay` method. The merchant serves data only after it verifies the final vault payment.” |
| 35–60 s | Run `ORBIT_ONLY=T-14b cargo test -p orbit-sandbox-tests --test sandbox -- --nocapture`. Show the final 5 paid / 15 rejected result and the matching merchant balance. | “Four distinct keys race 20 payments against one $0.25 shared cap. Exactly five settle. The cap is checked and reserved in contract state.” Say **local NEAR sandbox**, not live testnet. |
| 60–80 s | In the live testnet dashboard, pause one agent, then run `pnpm demo:attack --agent research-scout --once`. Show `agent_paused` in Activity. | “A separate guardian key can stop spending without being able to withdraw funds.” |
| 80–90 s | Show the public repository's evidence index and the one-line status. | “The vault and 402 purchase work on testnet. The Agent Market seller worker is built, but a real marketplace assignment has not yet been completed.” |

Use a fresh testnet vault and test token (`otusd`, no monetary value). The paid diagnostic reads public NEAR RPC data; the synthetic quote endpoint should not appear in the hero clip. The shared-cap race is a local sandbox run, separate from the live testnet payment. Do not cut between them in a way that implies one continuous production transaction.

## Prepare before recording

1. Follow [README.md](README.md#reproduce-on-testnet) to run the merchant, dashboard and testnet vault. Run `pnpm demo:agents market-check` separately if showing the private Agent Market draft; this is a read-only preflight, not a completed job.
2. Keep the keychain, key files, credentials, account setup commands, and browser tabs containing secrets off screen. Use a clean browser profile and crop terminal prompts before publishing.
3. Preload the dashboard and the exact testnet transaction explorer page. Record the transaction hash and payment ID so a judge can verify them from the repository's [evidence index](evidence/README.md).
4. Rehearse twice with a stopwatch. Use captions for `402 → pay → 200`, `5 paid / 15 rejected`, and `guardian pause` so the story works without sound.
5. Record one continuous run of each proof. Edit for pace, and label any earlier recorded evidence with its date. If a live transaction stalls, show its final status only after it resolves; do not imply a pending payment settled.

## If a real Agent Market job lands before submission

Replace the first purchase scene with the actual buyer assignment → seller's Orbit expense → final diagnostic → marketplace submission. Show the assignment ID, Orbit payment ID, testnet transaction hash, and marketplace submission receipt together. Confirm all four before calling the marketplace workflow live. The seller draft must remain unpublished until the team approves publication.

## Public demo post draft for the human to publish

> AI agents can spend faster than an operator can review every payment. We built Orbit at NEAR HACKATHON: one NEAR vault gives each agent a pay-only key and enforces a shared budget across the fleet. In this demo, an agent buys data with an on-chain 402 payment; a four-agent sandbox race settles 5 of 20 payments against a $0.25 cap. Testnet uses a valueless test token. Demo: [video] Code: [public repo]. What policy would your agent fleet need? @NEARProtocol #NEARHackathon

Replace the placeholders and have a human publish the post. The public post and public repository are submission requirements in the [official guidance](https://nearhackathon.com/HACKATHON.md). Recheck that guidance before submitting.
