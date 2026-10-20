# orbit-agent notes

## S-6 decision (2026-10-21): fastnear/x402-facilitator not adopted

fastnear/x402-facilitator implements x402 v2 `exact` on NEAR: the payer signs a NEP-366 delegate action carrying one Circle USDC `ft_transfer` from its own account, and the facilitator (API key, PostgreSQL journal) verifies and submits it. Orbit's payer is the vault: the agent's FC key calls `pay`, and the contract enforces limits before transferring. That inner action is not an `ft_transfer`, so the facilitator's verifier would refuse it, and using it would put a facilitator in the payment's trust path. We keep the `orbit-near` scheme of 2-lld.md section 4 (402 body, `X-PAYMENT` = base64url JSON `{payment_id, tx_hash, agent_pk, sig}`) and claim an "x402-style 402 flow", not x402 conformance.

## Behavior measured on testnet

- Re-broadcasting identical signed bytes returns the original outcome (same hash), not an `InvalidNonce` error; the vault never executes it twice. Demo copy for the rebroadcast line: "the network returns the original result; nothing runs twice".
- One key keeps at most `maxInFlight` (default 4) pays in flight. The vault allowance also caps this (1 NEAR: about 16 at 60 Tgas; see contracts/vault/NOTES.md). The burst agent uses 3 NEAR.
- A send that times out is `unknown`, resolved by `tx_status` at FINAL or `payment(id)` at final; `expired_unpaid` only when no payment exists after the deadline.
