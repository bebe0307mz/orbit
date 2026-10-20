#!/usr/bin/env bash
# Orbit testnet milestone: deploy otusd (test token) and the vault, register agents, then prove on chain:
#  (a) an agent pays the allowlisted merchant; (b) over-limit and unlisted-merchant payments are rejected
#  with their reason; (c) a paused agent cannot pay; (d) vault accounting equals the merchant's received
#  balance and the sum of paid outcomes; (e) agent keys are FunctionCall ["pay"] on the vault.
#
# Config from env (accounts must exist, created e.g. with
#   near account create-account sponsor-by-faucet-service <id> autogenerate-new-keypair save-to-legacy-keychain network-config testnet create):
#   ORBIT_VAULT ORBIT_OWNER ORBIT_TOKEN ORBIT_MERCHANT ORBIT_UNLISTED   (testnet account ids)
#   ORBIT_RPC (default https://rpc.testnet.near.org)
#   ORBIT_KEY_DIR (default ~/.near-credentials/orbit-testnet/<vault>): guardian and agent key files, never in the repo
#   ORBIT_SKIP_DEPLOY=1 to rerun only the proof against an existing deployment.
# Signing: owner, token and vault deploy key from the near-cli legacy keychain; agents and guardian from key files.
# Output: harness/out/testnet-<utc>/ (gitignored): proof.log, summary.json.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

: "${ORBIT_VAULT:?}" "${ORBIT_OWNER:?}" "${ORBIT_TOKEN:?}" "${ORBIT_MERCHANT:?}" "${ORBIT_UNLISTED:?}"
RPC="${ORBIT_RPC:-https://rpc.testnet.near.org}"
KEY_DIR="${ORBIT_KEY_DIR:-$HOME/.near-credentials/orbit-testnet/$ORBIT_VAULT}"
RUN="testnet-$(date -u +%Y%m%dT%H%M%SZ)"
OUT="harness/out/$RUN"
mkdir -p "$OUT" "$KEY_DIR"
chmod 700 "$KEY_DIR"
LOG="$OUT/proof.log"
TXS="$OUT/txs.tsv"
: > "$TXS"
EXPLORER="https://testnet.nearblocks.io/txns"

log() { echo "$*" | tee -a "$LOG"; }
fail() { log "FAIL: $*"; exit 1; }

# JSON-RPC view call -> JSON result on stdout.
view() {
  local contract=$1 method=$2 args=${3:-'{}'}
  local b64; b64=$(printf '%s' "$args" | base64 | tr -d '\n')
  curl -s "$RPC" -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$contract\",\"method_name\":\"$method\",\"args_base64\":\"$b64\"}}" \
    | python3 -c 'import sys,json; r=json.load(sys.stdin); res=r.get("result") or sys.exit("view error: %s" % r); print(bytes(res["result"]).decode() if "result" in res else sys.exit("view error: %s" % res))'
}

rpc_keys() {
  curl -s "$RPC" -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_access_key_list\",\"finality\":\"final\",\"account_id\":\"$1\"}}"
}

# Runs a near-cli command, records "label<TAB>tx_hash<TAB>return value", echoes the return value.
# The return value is near-cli's stdout; its progress output goes to stderr.
tx() {
  local label=$1; shift
  local out err rc=0
  err=$(mktemp)
  out=$(near "$@" 2>"$err") || rc=$?
  local hash; hash=$(grep -oE 'Transaction ID: [A-Za-z0-9]+' "$err" | tail -1 | awk '{print $3}' || true)
  cat "$err" >> "$LOG.cli"
  printf '%s\t%s\t%s\n' "$label" "${hash:-none}" "$(echo "$out" | tr -d '\n')" >> "$TXS"
  log "  tx [$label] ${hash:+$EXPLORER/$hash} -> $(echo "$out" | tr -d '\n' | head -c 300)"
  if [ $rc -ne 0 ]; then
    log "  near-cli exit $rc: $(grep -iE 'error|panic|Failure' "$err" | head -3 | tr '\n' ' ')"
  fi
  rm -f "$err"
  LAST_OUT="$out"
  LAST_HASH="${hash:-}"
  return $rc
}

owner_call() { # method json-args
  tx "owner:$1" contract call-function as-transaction "$ORBIT_VAULT" "$1" json-args "$2" \
    prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$ORBIT_OWNER" \
    network-config testnet sign-with-legacy-keychain send
}

keyfile_call() { # label keyfile method json-args gas
  tx "$1" contract call-function as-transaction "$ORBIT_VAULT" "$3" json-args "$4" \
    prepaid-gas "$5" attached-deposit '0 NEAR' sign-as "$ORBIT_VAULT" \
    network-config testnet sign-with-access-key-file "$2" send
}

now_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }

pay() { # label agent_name payment_id merchant amount
  local deadline=$(( $(now_ms) + 120000 ))
  keyfile_call "$1" "$KEY_DIR/$2.json" pay \
    "{\"payment_id\":\"$3\",\"merchant\":\"$4\",\"amount\":\"$5\",\"deadline_ms\":$deadline}" '60 Tgas'
}

new_pid() { python3 -c 'import secrets; print(secrets.token_hex(32))'; }

log "Orbit testnet proof run $RUN"
log "vault=$ORBIT_VAULT owner=$ORBIT_OWNER token=$ORBIT_TOKEN (otusd, TEST TOKEN) merchant=$ORBIT_MERCHANT unlisted=$ORBIT_UNLISTED"

if [ "${ORBIT_SKIP_DEPLOY:-0}" != "1" ]; then
  log "== deploy"
  scripts/build-contracts.sh | tee -a "$LOG"
  tx "token:deploy+new" contract deploy "$ORBIT_TOKEN" use-file target/near/mock_ft/mock_ft.wasm \
    with-init-call new json-args "{\"owner\":\"$ORBIT_OWNER\",\"symbol\":\"OTUSD\"}" \
    prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-legacy-keychain send

  GUARDIAN_PK=$(node scripts/lib/keygen.mjs "$ORBIT_VAULT" "$KEY_DIR/guardian.json")
  # Deploy + init in one tx with the vault's deploy key (K0).
  tx "vault:deploy+new" contract deploy "$ORBIT_VAULT" use-file target/near/orbit_vault/orbit_vault.wasm \
    with-init-call new json-args "{\"owner\":\"$ORBIT_OWNER\",\"token\":\"$ORBIT_TOKEN\",\"guardian_pk\":\"$GUARDIAN_PK\",\"float_cap\":\"20000000\",\"org_daily_limit\":\"1000000\"}" \
    prepaid-gas '300 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-legacy-keychain send

  for acc in "$ORBIT_VAULT" "$ORBIT_MERCHANT" "$ORBIT_UNLISTED"; do
    tx "token:storage_deposit:$acc" contract call-function as-transaction "$ORBIT_TOKEN" storage_deposit \
      json-args "{\"account_id\":\"$acc\",\"registration_only\":true}" prepaid-gas '30 Tgas' attached-deposit '0.01 NEAR' \
      sign-as "$ORBIT_OWNER" network-config testnet sign-with-legacy-keychain send
  done

  # Delete the deploy key: afterwards the vault holds only the guardian and agent FC keys.
  K0=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["public_key"])' "$HOME/.near-credentials/testnet/$ORBIT_VAULT.json")
  tx "vault:delete-deploy-key" account delete-keys "$ORBIT_VAULT" public-keys "$K0" network-config testnet sign-with-legacy-keychain send

  owner_call add_merchant "{\"account\":\"$ORBIT_MERCHANT\",\"name\":\"Orbit Data (testnet demo)\"}"
  for name in agent-1 agent-2 agent-3; do
    PK=$(node scripts/lib/keygen.mjs "$ORBIT_VAULT" "$KEY_DIR/$name.json")
    owner_call register_agent "{\"name\":\"$name\",\"public_key\":\"$PK\",\"per_payment_limit\":\"100000\",\"daily_limit\":\"250000\",\"allowance\":\"1000000000000000000000000\"}"
  done

  tx "token:mint" contract call-function as-transaction "$ORBIT_TOKEN" mint \
    json-args "{\"account_id\":\"$ORBIT_OWNER\",\"amount\":\"5000000\"}" prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
    sign-as "$ORBIT_OWNER" network-config testnet sign-with-legacy-keychain send
  tx "owner:deposit" contract call-function as-transaction "$ORBIT_TOKEN" ft_transfer_call \
    json-args "{\"receiver_id\":\"$ORBIT_VAULT\",\"amount\":\"5000000\",\"msg\":\"\"}" prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' \
    sign-as "$ORBIT_OWNER" network-config testnet sign-with-legacy-keychain send
fi

check_result() { # expected-substring
  echo "$LAST_OUT" | grep -q "$1" || fail "expected $1, got: $LAST_OUT"
  log "  OK: $1"
}

# Each run registers two fresh agents (daily 0.15, per-payment 0.10), so the proof is rerunnable
# on one deployment (about 0.15 OTUSD per run against the 1.00 org daily limit).
TAG="p$(date -u +%H%M%S)"
A="$TAG-a"; B="$TAG-b"
log "== register run agents $A and $B (owner)"
for name in "$A" "$B"; do
  PK=$(node scripts/lib/keygen.mjs "$ORBIT_VAULT" "$KEY_DIR/$name.json")
  owner_call register_agent "{\"name\":\"$name\",\"public_key\":\"$PK\",\"per_payment_limit\":\"100000\",\"daily_limit\":\"150000\",\"allowance\":\"250000000000000000000000\"}"
done
B_ID=$(echo "$LAST_OUT" | tr -d ' "\n')
sleep 2

log "== (a) $A pays the allowlisted merchant 0.05 OTUSD"
pay "a:$A pays merchant 0.05" "$A" "$(new_pid)" "$ORBIT_MERCHANT" 50000
check_result '"status": *"paid"'

log "== (b) rejections on chain with reasons"
pay "b1:$A pays 0.15 (per-payment limit 0.10)" "$A" "$(new_pid)" "$ORBIT_MERCHANT" 150000
check_result '"reason": *"over_per_payment_limit"'
pay "b2:$A pays 0.10 (spent 0.15 of 0.15)" "$A" "$(new_pid)" "$ORBIT_MERCHANT" 100000
check_result '"status": *"paid"'
pay "b3:$A pays 0.01 (daily limit reached)" "$A" "$(new_pid)" "$ORBIT_MERCHANT" 10000
check_result '"reason": *"over_agent_daily_limit"'
pay "b4:$B pays unlisted merchant" "$B" "$(new_pid)" "$ORBIT_UNLISTED" 10000
check_result '"reason": *"merchant_not_allowed"'

log "== (c) guardian pauses $B (agent_id $B_ID); $B cannot pay"
keyfile_call "c1:guardian pause_agent($B_ID)" "$KEY_DIR/guardian.json" pause_agent "{\"agent_id\":$B_ID}" '30 Tgas'
pay "c2:paused $B pays" "$B" "$(new_pid)" "$ORBIT_MERCHANT" 50000
check_result '"reason": *"agent_paused"'

log "== (d) accounting"
sleep 3
STATE=$(view "$ORBIT_VAULT" state)
OUTC=$(view "$ORBIT_VAULT" outcomes '{"from_seq":0,"limit":100}')
M_AFTER=$(view "$ORBIT_TOKEN" ft_balance_of "{\"account_id\":\"$ORBIT_MERCHANT\"}" | tr -d '"')
V_BAL=$(view "$ORBIT_TOKEN" ft_balance_of "{\"account_id\":\"$ORBIT_VAULT\"}" | tr -d '"')
KEYS=$(rpc_keys "$ORBIT_VAULT")
echo "$STATE" > "$OUT/state.json"
echo "$OUTC" > "$OUT/outcomes.json"
echo "$KEYS" > "$OUT/access_keys.json"

python3 - "$OUT" "0" "$M_AFTER" "$V_BAL" "$ORBIT_VAULT" "$EXPLORER" <<'PY' | tee -a "$LOG"
import json, sys
out, m_before, m_after, v_bal, vault, explorer = sys.argv[1:7]
s = json.load(open(f"{out}/state.json"))
o = json.load(open(f"{out}/outcomes.json"))
keys = json.load(open(f"{out}/access_keys.json"))["result"]["keys"]
n = lambda x: int(x)
paid_sum = sum(n(e["amount"]) for e in o["entries"] if e["kind"] == "paid")
received = n(m_after)  # merchant received only from this vault (fresh deployment)
checks = []
def chk(name, ok, detail):
    checks.append({"check": name, "ok": bool(ok), "detail": detail})
    print(f"  {'OK ' if ok else 'BAD'} {name}: {detail}")
chk("paid_total == merchant received balance", n(s["paid_total"]) == received, f'{s["paid_total"]} vs {received}')
chk("paid_total == sum(paid outcomes)", n(s["paid_total"]) == paid_sum, f'{s["paid_total"]} vs {paid_sum}')
chk("P1 conservation", n(s["deposited_total"]) == n(s["available"]) + n(s["reserved"]) + n(s["paid_total"]) + n(s["withdrawn_total"]),
    f'{s["deposited_total"]} = {s["available"]}+{s["reserved"]}+{s["paid_total"]}+{s["withdrawn_total"]}')
chk("P3 counters", s["counts"]["next_seq"] == s["counts"]["paid"] + s["counts"]["failed"] + s["counts"]["rejected"], json.dumps(s["counts"]))
chk("P6 token backing", n(v_bal) >= n(s["available"]) + n(s["reserved"]), f'vault ft {v_bal} >= {n(s["available"]) + n(s["reserved"])}')
chk("P8 quiescent", s["pending_count"] == 0 and s["reserved"] == "0", f'pending {s["pending_count"]}')
agent_pks = {a["pk"]: a for a in s["agents"] if a["status"] != "revoked"}
perm = {}
for k in keys:
    p = k["access_key"]["permission"]
    perm[k["public_key"]] = p
full = [pk for pk, p in perm.items() if p == "FullAccess"]
chk("no full-access key on the vault", not full, f"{len(keys)} keys")
for pk, a in agent_pks.items():
    p = perm.get(pk, {}).get("FunctionCall") if isinstance(perm.get(pk), dict) else None
    ok = p is not None and p["method_names"] == ["pay"] and p["receiver_id"] == vault and p["allowance"] not in (None, "0")
    chk(f'agent {a["name"]} key FunctionCall ["pay"]', ok, json.dumps(p))
g = perm.get(s["guardian_pk"], {})
gp = g.get("FunctionCall") if isinstance(g, dict) else None
chk('guardian key FunctionCall ["pause_agent","pause_all"]', gp is not None and gp["method_names"] == ["pause_agent", "pause_all"], json.dumps(gp))
chk("key set == guardian + live agents", set(perm) == set(agent_pks) | {s["guardian_pk"]}, f"{len(perm)} keys")
txs = [l.rstrip("\n").split("\t") for l in open(f"{out}/txs.tsv")]
summary = {
    "vault": vault, "block_height": s["block_height"], "state": {k: s[k] for k in ("available", "reserved", "paid_total", "deposited_total")},
    "counts": s["counts"], "merchant_received": received, "checks": checks,
    "txs": [{"label": t[0], "tx": t[1], "link": f"{explorer}/{t[1]}" if t[1] != "none" else None, "result": t[2] if len(t) > 2 else ""} for t in txs],
}
json.dump(summary, open(f"{out}/summary.json", "w"), indent=2)
bad = [c for c in checks if not c["ok"]]
print(f"VERDICT: {len(checks) - len(bad)} checks OK, {len(bad)} failed")
sys.exit(1 if bad else 0)
PY
log "artifacts: $OUT (summary.json, proof.log, state.json, outcomes.json, access_keys.json)"
