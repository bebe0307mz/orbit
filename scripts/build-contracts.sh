#!/usr/bin/env bash
# Local (non-reproducible) contract builds, cargo-near 0.22 / rust 1.86.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH" CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}"
mkdir -p target/near/orbit_vault target/near/mock_ft
orbit_cargo=${ORBIT_CARGO:-cargo}
staging=$(mktemp -d target/near/.orbit-build.XXXXXX)
complete=false
artifacts=(target/near/orbit_vault/orbit_vault{,_migrate_panic,_mainnet}.wasm target/near/mock_ft/mock_ft.wasm)
cleanup() {
  if [ "$complete" != true ]; then rm -f "${artifacts[@]}"; fi
  rm -rf "$staging"
}
trap cleanup EXIT
# Invalidate old outputs before starting. A failure must never leave a seemingly
# usable older binary, including a variant built successfully earlier in this run.
rm -f "${artifacts[@]}"
build_variant() {
  local crate=$1 output=$2 artifact=$3
  shift 3
  # cargo-near shares the vault output path across all feature variants.
  rm -f "$artifact"
  (cd "contracts/$crate" && "$orbit_cargo" near build non-reproducible-wasm --no-abi "$@")
  if [ ! -s "$artifact" ]; then
    printf 'Build did not produce a nonempty artifact: %s\n' "$artifact" >&2
    return 1
  fi
  cp "$artifact" "$staging/$output"
}
build_variant vault orbit_vault_migrate_panic.wasm target/near/orbit_vault/orbit_vault.wasm --features test-migrate-panic "$@"
# Pins Circle USDC and float_cap <= 20 USDC; this does not authorize deployment.
build_variant vault orbit_vault_mainnet.wasm target/near/orbit_vault/orbit_vault.wasm --features mainnet "$@"
build_variant mock-ft mock_ft.wasm target/near/mock_ft/mock_ft.wasm "$@"
build_variant vault orbit_vault.wasm target/near/orbit_vault/orbit_vault.wasm "$@"
# Publish the complete set only after every build has succeeded.
for name in orbit_vault orbit_vault_mainnet orbit_vault_migrate_panic; do
  mv "$staging/$name.wasm" "target/near/orbit_vault/$name.wasm"
done
mv "$staging/mock_ft.wasm" target/near/mock_ft/mock_ft.wasm
complete=true
