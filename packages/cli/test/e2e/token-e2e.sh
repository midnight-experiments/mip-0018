#!/usr/bin/env bash
# End-to-end proof that a Blockfrost project token reaches no output: every mip0018 command runs against the local stack
# (docker/local-stack) behind blockfrost-stub.ts, a front that requires `project_id` on every HTTP request and every
# WebSocket upgrade, with a random sentinel token. Then stdout, stderr, logs, run records, index states, observations,
# wallet caches and the stub's own log are searched for the token.
#
#   MIP0018_DOCKER_PREFIX=<prefix> MIP0018_E2E_DIR=<empty dir outside the repo> packages/cli/test/e2e/token-e2e.sh
#
# Needs the compiled contracts (full keys) of local-e2e.sh plus the upgrade example:
#   docker/run.sh compile:spike; docker/run.sh exec 'npm run compile -w test-contracts/scanner-mints'
#   docker/run.sh exec 'npm run -s compile -w examples/upgrade-existing-contract -- --keys'
#
# Runs (success paths, through the stub with the token): wallet status, register-dust, deploy, publish, call,
# remove-circuit, deploy-and-publish, upgrade, check-event, list, index (subscription and polling), lookup --network,
# recheck — the undeployed profile with MIP0018_TEST_UNDEPLOYED_TOKEN (the network's own chain, so transactions
# succeed); check-event, list and index with `--network preprod` and MIP0018_BLOCKFROST_PREPROD through the stub's
# listener that answers the preprod genesis. Failure paths: a wrong token (HTTP 403 → token error), preprod without a
# token (stops before any request), an endpoint that refuses connections, three 429 answers (the client pauses and
# goes on), a signer command with a wrong token, a refused call.
#
# Wallet A = the local dev chain's public genesis wallet (no secret). The token is passed to containers by NAME only.
# Starts the stack unless MIP0018_E2E_REUSE_STACK=1; removes what it started (the stub by exact name) on exit.
# Exit = number of failures. bash 3.2 compatible.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd -P)"
repo="$(cd "$here/../../../.." && pwd -P)"
: "${MIP0018_DOCKER_PREFIX:?set MIP0018_DOCKER_PREFIX}"
: "${MIP0018_E2E_DIR:?set MIP0018_E2E_DIR to an empty directory outside the repository}"
export MIP0018_DOCKER_PREFIX
E2E="$(cd "$MIP0018_E2E_DIR" && pwd -P)"
case "$E2E/" in "$repo"/*) echo "MIP0018_E2E_DIR must be outside the repository" >&2; exit 2 ;; esac
# shellcheck source=docker/common.sh
. "$repo/docker/common.sh"
mip0018_ensure_image

SECRETS="$E2E/secrets"; STATE="$E2E/state"; RECORDS="$E2E/records"; LOGS="$E2E/logs"; INDEX="$E2E/index"
mkdir -p "$SECRETS" "$STATE" "$RECORDS" "$LOGS" "$INDEX" "$E2E/case"
chmod 700 "$SECRETS" "$STATE"
RESULTS="$E2E/results.txt"
: >"$RESULTS"
failures=0

say() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
pass() { printf 'PASS %s\n' "$*" | tee -a "$RESULTS" >&2; }
fail() { printf 'FAIL %s\n' "$*" | tee -a "$RESULTS" >&2; failures=$((failures + 1)); }
check() { local name="$1"; shift; if "$@" >>"$LOGS/checks.log" 2>&1; then pass "$name"; else fail "$name"; fi; }
expect_rc() { if [ "$3" = "$2" ]; then pass "$1 (exit $3)"; else fail "$1 (exit $3, expected $2)"; fi; }
py() { python3 -c "$@"; }
jget() { py "import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2], {'d': d}))" "$1" "$2"; }

# The sentinel token (letters and digits, like a Blockfrost project id) and a wrong one. Exported, passed by name.
STUB_TOKEN="Sentinel$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
WRONG_TOKEN="Wrong$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
export STUB_TOKEN MIP0018_TEST_UNDEPLOYED_TOKEN="$STUB_TOKEN" MIP0018_BLOCKFROST_PREPROD="$STUB_TOKEN"
PREPROD_GENESIS="$(py "import json; print(json.load(open('$repo/toolchain.json'))['networks']['preprod']['genesisHash'])")"

STACK_UP=""
STUB="${MIP0018_DOCKER_PREFIX}-stub-$(mip0018_rand)"
STUB_STARTED=""
cleanup() {
  if [ -n "$STUB_STARTED" ]; then
    docker logs "$STUB" >"$LOGS/stub.log" 2>&1 || true
    docker rm -f "$STUB" >/dev/null 2>&1 || true
    say "stub $STUB removed"
  fi
  if [ -n "$STACK_UP" ] && [ -z "${MIP0018_E2E_KEEP:-}" ]; then
    MIP0018_KEEP_LOGS=1 "$repo/docker/local-stack/down.sh" >>"$LOGS/stack.log" 2>&1 || true
    say "stack removed"
  fi
}
trap cleanup EXIT

if [ -n "${MIP0018_E2E_REUSE_STACK:-}" ] && [ -f "$repo/docker/local-stack/ports.env" ]; then
  say "reusing the running local stack"
else
  say "starting the local stack"
  "$repo/docker/local-stack/up.sh" >>"$LOGS/stack.log" 2>&1
  STACK_UP=1
fi
# shellcheck disable=SC1091
. "$repo/docker/local-stack/ports.env"
NET="$MIP0018_STACK_NETWORK"

say "starting $STUB"
docker run -d --name "$STUB" --label "$MIP0018_LABEL" --network "$NET" --user "$(id -u):$(id -g)" \
  -e HOME=/tmp -e STUB_TOKEN \
  -v "$repo:/work:ro" -v "${MIP0018_DOCKER_PREFIX}-node-modules:/work/node_modules:ro" -w /work \
  "$MIP0018_IMAGE" node packages/cli/test/e2e/blockfrost-stub.ts --genesis "$PREPROD_GENESIS" >/dev/null
STUB_STARTED=1
for _ in $(seq 1 30); do docker logs "$STUB" 2>&1 | grep -q 'listening on :8082' && break; sleep 1; done
check "stub listening" sh -c "docker logs '$STUB' 2>&1 | grep -q 'listening on :8082'"

TOKEN_ENV="-e MIP0018_TEST_UNDEPLOYED_TOKEN -e MIP0018_BLOCKFROST_PREPROD -v $E2E:/e2e"
cli() { # cli <log name> <mip0018 args...>
  local name="$1"; shift
  MIP0018_DOCKER_NETWORK="$NET" MIP0018_DOCKER_ENV="$TOKEN_ENV ${EXTRA_ENV:-}" "$repo/docker/run.sh" mip0018 -- "$@" \
    </dev/null >"$LOGS/$name.out" 2>"$LOGS/$name.err"
}
signer() { # signer <log name> <mip0018 args...>
  local name="$1"; shift
  MIP0018_DOCKER_NETWORK="$NET" MIP0018_SECRET_DIR="$SECRETS" MIP0018_STATE_DIR="$STATE" \
    MIP0018_DOCKER_ENV="$TOKEN_ENV -e MIP0018_PROOF_SERVER_URL=$MIP0018_PROOF_SERVER_URL_IN_NETWORK ${EXTRA_ENV:-}" \
    "$repo/docker/signer.sh" mip0018 -- "$@" </dev/null >"$LOGS/$name.out" 2>"$LOGS/$name.err"
}
T="--network undeployed --rpc http://$STUB:8080/rpc --indexer http://$STUB:8080/api/v0"
P="--network preprod --rpc http://$STUB:8081/rpc --indexer http://$STUB:8081/api/v0"
A="$T --dev-genesis-wallet --wallet-cache /run/mip0018/state/a.wallet-cache"

# ------------------------------------------------------------------------------- signer commands, success paths
say "signer commands through the stub"
rc=0; signer wallet wallet status $A --json || rc=$?
expect_rc "wallet status" 0 "$rc"
CPK_A="$(jget "$LOGS/wallet.out" 'd["coinPublicKey"]')"
rc=0; signer register wallet register-dust $A --json || rc=$?
expect_rc "wallet register-dust" 0 "$rc"
EM="test-contracts/toolchain-spike/managed/SpikeEmitter"
rc=0; signer deploy deploy $A --contract "$EM" --record /e2e/records/emitter.json || rc=$?
expect_rc "deploy SpikeEmitter" 0 "$rc"
EM_ADDR="$(jget "$RECORDS/emitter.json" 'd["contract"]["address"]')"
rc=0; signer publish publish $A --record /e2e/records/emitter.json --circuit publishMetadata --step publish || rc=$?
expect_rc "publish (A1)" 0 "$rc"
PUB_TX="$(jget "$RECORDS/emitter.json" '[s for s in d["steps"] if s["id"]=="publish"][0]["tx"]["hash"]')"
rc=0; signer remove remove-circuit $A --record /e2e/records/emitter.json --circuit publishMetadata || rc=$?
expect_rc "remove-circuit" 0 "$rc"
rc=0; signer call-refused call $A --record /e2e/records/emitter.json --circuit publishMetadata --step after-remove --force || rc=$?
expect_rc "call of a removed circuit: refused before submission" 1 "$rc"
A1_META='{"domainSep":"0x1111111111111111111111111111111111111111111111111111111111111111","kind":3,"name":"Acme Token","symbol":"ACME","decimals":6,"standards":["mip-0004"]}'
rc=0; signer dap deploy-and-publish $A --example toolchain-spike --metadata "$A1_META" --record /e2e/records/dap.json || rc=$?
expect_rc "deploy-and-publish" 0 "$rc"
SM="test-contracts/scanner-mints/managed/ScannerMints"
DS="0x$(printf '36%.0s' $(seq 1 32))"
rc=0; signer sm-deploy deploy $A --contract "$SM" --record /e2e/records/sm.json || rc=$?
expect_rc "deploy ScannerMints" 0 "$rc"
rc=0; signer sm-call call $A --record /e2e/records/sm.json --circuit mintUnshielded --args "[\"$DS\",77]" || rc=$?
expect_rc "call mintUnshielded" 0 "$rc"
rc=0; signer sm-publish publish $A --record /e2e/records/sm.json --circuit publishMetadata --args "[\"$DS\",2,{\"\$utf8\":\"TOKN\"}]" || rc=$?
expect_rc "publish kind-2 metadata" 0 "$rc"
EX="examples/upgrade-existing-contract"
rc=0; signer legacy deploy $A --adapter "$EX/legacy/mip0018.adapter.ts" --args "[\"0x$(printf '5f%.0s' $(seq 1 32))\"]" --record /e2e/records/legacy.json || rc=$?
expect_rc "deploy LegacyToken" 0 "$rc"
rc=0; signer upgrade upgrade $A --record /e2e/records/legacy.json --source "$EX/upgrade" --circuit publishMetadata || rc=$?
expect_rc "upgrade (VerifierKeyInsert, call)" 0 "$rc"

# ------------------------------------------------------------------------------ wallet-free commands, success paths
say "wallet-free commands through the stub"
rc=0; cli check-event check-event $T --record /e2e/records/emitter.json --step publish --json || rc=$?
expect_rc "check-event" 0 "$rc"
rc=0; cli list list $T --record /e2e/records/emitter.json --json || rc=$?
expect_rc "list" 0 "$rc"
FROM="$(jget "$RECORDS/emitter.json" 'min(s["inclusion"]["height"] for s in d["steps"] if s.get("inclusion"))-2')"
TO="$(jget "$RECORDS/sm.json" 'max(s["inclusion"]["height"] for s in d["steps"] if s.get("inclusion"))')"
rc=0; cli index index $T --from-height "$FROM" --to-height "$TO" --state /e2e/index/ws --json || rc=$?
expect_rc "index (WebSocket subscription)" 0 "$rc"
rc=0; cli index-poll index $T --from-height "$FROM" --to-height "$TO" --state /e2e/index/poll --poll --json || rc=$?
expect_rc "index --poll" 0 "$rc"
rc=0; cli lookup lookup $T --record /e2e/records/sm.json --domain-sep "$DS" --kind 2 --state /e2e/index/ws --json || rc=$?
expect_rc "lookup --network (live metadata)" 0 "$rc"
check "lookup resolved the kind-2 metadata live" grep -q '"TOKN"\|TOKN' "$LOGS/lookup.out"
cp "$RECORDS/emitter.json" "$E2E/case/record.json"
py "import json; json.dump({'kind':'mip0018-case','schema':1,'id':'TOKEN','recheck':{'checkEvent':[{'record':'record.json','step':'publish'}],'operationsAbsent':[{'record':'record.json','circuit':'publishMetadata'}]}}, open('$E2E/case/case.json','w'))"
rc=0; cli recheck recheck $T --case /e2e/case || rc=$?
expect_rc "recheck" 0 "$rc"
rc=0; cli preprod-check-event check-event $P --contract "$EM_ADDR" --tx "$PUB_TX" --json || rc=$?
expect_rc "check-event --network preprod (stub answers the preprod genesis)" 0 "$rc"
check "… the report names preprod and the pinned genesis" grep -q "\"genesisHash\": \"$PREPROD_GENESIS\"" "$LOGS/preprod-check-event.out"
rc=0; cli preprod-list list $P --contract "$EM_ADDR" --json || rc=$?
expect_rc "list --network preprod" 0 "$rc"
rc=0; cli preprod-index index $P --from-height "$FROM" --to-height "$TO" --state /e2e/index/preprod --json || rc=$?
expect_rc "index --network preprod (WebSocket)" 0 "$rc"

# --------------------------------------------------------------------------------------------------- failure paths
say "failure paths"
rc=0; MIP0018_TEST_UNDEPLOYED_TOKEN="$WRONG_TOKEN" cli wrong-token list $T --contract "$EM_ADDR" || rc=$?
expect_rc "wrong token: refused" 1 "$rc"
check "wrong token: HTTP 403 named as a token error with the variable" grep -q "HTTP 403 from http://$STUB:8080/rpc: the Blockfrost project token from MIP0018_TEST_UNDEPLOYED_TOKEN was refused" "$LOGS/wrong-token.err"
rc=0; MIP0018_TEST_UNDEPLOYED_TOKEN="$WRONG_TOKEN" signer wrong-token-signer deploy $A --contract "$EM" --record /e2e/records/wrong.json || rc=$?
expect_rc "signer with a wrong token: refused before anything else" 1 "$rc"
check "… and wrote no record" test ! -e "$RECORDS/wrong.json"
rc=0; MIP0018_BLOCKFROST_PREPROD="" cli no-token list $P --contract "$EM_ADDR" || rc=$?
expect_rc "preprod without a token: stops before any request (usage)" 2 "$rc"
check "… naming the variable" grep -q "MIP0018_BLOCKFROST_PREPROD" "$LOGS/no-token.err"
rc=0; cli refused list --network undeployed --rpc "http://$STUB:9/rpc" --indexer "http://$STUB:9/api/v0" --contract "$EM_ADDR" || rc=$?
expect_rc "an endpoint that refuses connections" 1 "$rc"
check "… named without its query string" grep -q "request to http://$STUB:9/rpc failed" "$LOGS/refused.err"
rc=0; cli limited list --network undeployed --rpc "http://$STUB:8082/rpc" --indexer "http://$STUB:8082/api/v0" --contract "$EM_ADDR" --json || rc=$?
expect_rc "three 429 answers: the client pauses, then completes" 0 "$rc"

# ------------------------------------------------------------------------------------------------ the token search
docker logs "$STUB" >"$LOGS/stub.log" 2>&1 || true
STATS="$(docker exec "$STUB" node -e "fetch('http://127.0.0.1:8080/stub-stats?project_id='+process.env.STUB_TOKEN).then(r=>r.text()).then(t=>console.log(t))")"
printf '%s\n' "$STATS" >"$LOGS/stub-stats.json"
check "the stub served requests with the token and limited three" py "
import json; s=json.load(open('$LOGS/stub-stats.json')); print(s)
assert s['withToken'] > 20 and s['limited'] == 3, s
assert s['withoutToken'] == 0, 'a request without the token reached the stub'
"
check "no file under the run directory and no stub log line contains the token (or the wrong token)" env WRONG_TOKEN="$WRONG_TOKEN" python3 -c "
import os
toks=[os.environ['STUB_TOKEN'], os.environ['WRONG_TOKEN']]
hits=[]; n=0
for root in ['$LOGS','$RECORDS','$INDEX','$STATE','$E2E/case']:
  for dp,_,fs in os.walk(root):
    for fn in fs:
      p=os.path.join(dp,fn); n+=1
      t=open(p,'rb').read()
      for k in toks:
        if k.encode() in t: hits.append((p, k[:6]))
assert n > 40, n
assert not hits, hits
print('files searched:', n)
"
check "no query string with a project id in any log or record" sh -c "! grep -rIl 'project_id=[A-Za-z0-9]' '$LOGS' '$RECORDS' '$INDEX' '$E2E/case'"

say "done: $failures failure(s)"
exit "$failures"
