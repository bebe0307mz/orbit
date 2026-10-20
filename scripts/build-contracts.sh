#!/usr/bin/env bash
# Builds contract wasm into target/near/<crate>/<crate>.wasm (cargo-near 0.22, rust 1.86).
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH" CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}"
# Test-only variant first (cargo-near writes to the same path), kept as orbit_vault_migrate_panic.wasm.
(cd contracts/vault && cargo near build non-reproducible-wasm --no-abi --features test-migrate-panic "$@" 2>&1 | grep -E "error" || true)
cp target/near/orbit_vault/orbit_vault.wasm target/near/orbit_vault/orbit_vault_migrate_panic.wasm
# Mainnet build (pins Circle USDC, float_cap <= 20 USDC), kept as orbit_vault_mainnet.wasm.
(cd contracts/vault && cargo near build non-reproducible-wasm --no-abi --features mainnet "$@" 2>&1 | grep -E "error" || true)
cp target/near/orbit_vault/orbit_vault.wasm target/near/orbit_vault/orbit_vault_mainnet.wasm
for c in mock-ft vault; do
  (cd "contracts/$c" && cargo near build non-reproducible-wasm --no-abi "$@" 2>&1 | grep -E "Binary|SHA-256|error" || true)
done
