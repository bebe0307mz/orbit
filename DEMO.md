# A shared budget, in 30 seconds

[Watch the actual app](evidence/demo.mp4). The clip uses the bright dashboard, concise captions and narration generated from a provided team voice model. No new payment is sent during the recording.

## Reproduce the moment

Start the dashboard with the public testnet source, using the normal repository setup:

```sh
VITE_SOURCE=rpc VITE_NETWORK=testnet VITE_VAULT_ACCOUNT_ID=orbit-ws-11a7-vault.testnet pnpm --filter @orbit/dashboard dev --host 127.0.0.1 --port 5184 --strictPort
```

Open `http://127.0.0.1:5184`.

1. Click **Replay 20-payment race** (`#replayBurst`).
2. See the exact recorded **15 paid / 5 blocked / $0 overspent** result. The shared cap is **$1.50 in no-value test-token units**.
3. Click **Inspect a blocked payment** (`#inspectBlocked`). Open **View NEAR transaction** inside `#burstReceipt` to inspect the exact rejected transaction.
4. The live dashboard below is separate from the recorded replay and states its own source. Its current totals can differ from the historical race.

The replay is derived from the committed [11 November workspace burst](evidence/testnet-workspace-burst-2026-11-11.json), not new network activity. Its precise fixture filename and complete proof instructions are in [evidence/README.md](evidence/README.md). The proof-fidelity test compares all 20 transaction hashes and outcomes with the original record. The animation timing is illustrative, not observed transaction arrival timing. Every dollar amount uses no-value test-token units, not real USD.

## Production notes

The recording is actual app footage sampled about 10 times per second, encoded at 30 fps. Captions and narration were added. It contains no slides or fabricated payment screens. [Desktop](evidence/bright-desktop.jpg) and [390px phone check](evidence/bright-phone.jpg) show the new interface. Reduced motion is respected.

Build, TypeScript and 25 dashboard tests passed for this revision. Contract/backend code and key permissions were not changed. No transaction, publication or deployment was performed for this presentation update. See the main README for existing contract, administrator and marketplace limitations.
