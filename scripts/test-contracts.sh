#!/usr/bin/env bash
# Contract harness: unit tests (U), then sandbox integration (S). Writes harness/out/sandbox.json.
# Run one cargo job at a time (shared 16 GB machine).
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH" CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}"
scripts/build-contracts.sh
cargo test -p orbit-vault --lib 2>&1 | grep -E "^test |test result"
cargo test -p orbit-sandbox-tests --test sandbox -- --nocapture 2>&1 | sed -n '/ORBIT SANDBOX HARNESS/,/test result/p'
