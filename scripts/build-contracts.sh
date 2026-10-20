#!/usr/bin/env bash
# Builds contract wasm into target/near/<crate>/<crate>.wasm (cargo-near 0.22, rust 1.86).
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH" CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}"
for c in mock-ft vault; do
  (cd "contracts/$c" && cargo near build non-reproducible-wasm --no-abi "$@" 2>&1 | grep -E "Binary|SHA-256|error" || true)
done
