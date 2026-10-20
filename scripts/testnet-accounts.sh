#!/usr/bin/env bash
# Creates fresh testnet accounts through the NEAR faucet (10 testnet NEAR each), keys in the near-cli legacy
# keychain (~/.near-credentials/testnet/, chmod 600), and prints the env lines for orbit-cli.
# Usage: scripts/testnet-accounts.sh <suffix> [roles...]   roles default: owner vault token merchant unlisted
# Accounts: orbit-<role>-<suffix>.testnet. Existing accounts are skipped (exit 0) so the script can be rerun.
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
SUFFIX="${1:?usage: testnet-accounts.sh <suffix> [roles...]}"; shift || true
[[ "$SUFFIX" =~ ^[a-z0-9]{1,20}$ ]] || { echo "suffix must be [a-z0-9]{1,20}" >&2; exit 2; }
ROLES=("$@"); [ ${#ROLES[@]} -gt 0 ] || ROLES=(owner vault token merchant unlisted)
RPC="${ORBIT_RPC:-https://test.rpc.fastnear.com}"
exists() {
  curl -s "$RPC" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}}" | grep -q '"amount"'
}
for role in "${ROLES[@]}"; do
  id="orbit-$role-$SUFFIX.testnet"
  if exists "$id"; then echo "exists: $id" >&2; else
    near account create-account sponsor-by-faucet-service "$id" autogenerate-new-keypair save-to-legacy-keychain network-config testnet create </dev/null >/dev/null 2>&1 \
      || { echo "faucet failed for $id (rate limit? retry in a minute)" >&2; exit 1; }
    echo "created: $id" >&2
    sleep 2
  fi
  chmod 600 "$HOME/.near-credentials/testnet/$id.json" 2>/dev/null || true
  chmod 600 "$HOME/.near-credentials/testnet/$id"/*.json 2>/dev/null || true
  upper=$(echo "$role" | tr a-z A-Z)
  echo "export ${upper}_ACCOUNT_ID=$id"
done
echo "export NEAR_NETWORK=testnet"
