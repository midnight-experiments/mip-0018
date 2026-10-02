#!/usr/bin/env bash
# End-to-end test of the examples and of S5's case folders on a local undeployed chain (docker/local-stack, official
# images only). Companion of local-e2e.sh (which covers the CLI's crash/resume, scanner kill/resume, identity guards).
#
#   MIP0018_DOCKER_PREFIX=<prefix> MIP0018_E2E_DIR=<empty dir outside the repo> packages/cli/test/e2e/examples-e2e.sh
#
# Needs the examples compiled WITH keys (deploy-and-publish compiles a missing one itself):
#   docker/run.sh exec 'npm run -s compile -w examples/minimal -- --keys CreateAndDestroy OwnerKey'
#   docker/run.sh exec 'npm run -s compile -w examples/openzeppelin -- --keys --with-metadata-only'
#   docker/run.sh exec 'npm run -s compile -w test-contracts/raw-emitter -- --keys'
#
# Parts (MIP0018_E2E_PARTS, default "A B C D"):
#   A  happy path: deploy-and-publish of examples/minimal and every examples/openzeppelin/* example → verify → list
#      --expect <the example's metadata.json>; one re-run (every step already completed)
#   B  the publish-and-emit walkthrough: rename, withdraw, withdraw again, revive on the fungible token with `publish`
#      (list after each = metadata.json lifecycle); create-and-destroy on the minimal example (remove-circuit, then a
#      publish refused before submission)
#   C  every Stagenet case folder (deployments/stagenet/cases/C01…C10, IDX) run on the local chain: each step's
#      command expanded by case.py (local wallets and paths), its exit code = the case's; outputs saved like S5 will
#   D  `mip0018 recheck` of every case (wallet-free, one command each) + a secret scan of every log, record and state
#
# Wallets: A = the dev chain's public genesis wallet (with a 0600 sync cache); B = a fresh local test wallet funded by
# docker/local-stack/fund.sh (hex seed in $MIP0018_E2E_DIR/secrets, 0600). Records are resumable: re-running the
# script with the same MIP0018_E2E_DIR and MIP0018_E2E_REUSE_STACK=1 skips completed steps. bash 3.2 compatible.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd -P)"
repo="$(cd "$here/../../../.." && pwd -P)"
: "${MIP0018_DOCKER_PREFIX:?set MIP0018_DOCKER_PREFIX (e.g. mips-00013-s4d-<rand>)}"
: "${MIP0018_E2E_DIR:?set MIP0018_E2E_DIR to an empty directory outside the repository}"
export MIP0018_DOCKER_PREFIX
E2E="$(cd "$MIP0018_E2E_DIR" && pwd -P)"
case "$E2E/" in "$repo"/*) echo "MIP0018_E2E_DIR must be outside the repository" >&2; exit 2 ;; esac
PARTS=" ${MIP0018_E2E_PARTS:-A B C D} "

SECRETS="$E2E/secrets"; STATE="$E2E/state"; LOGS="$E2E/logs"; DAP="$E2E/dap"; CASES="$E2E/cases"
mkdir -p "$SECRETS" "$STATE" "$LOGS" "$DAP" "$CASES"
chmod 700 "$SECRETS" "$STATE"
RESULTS="$E2E/results.txt"
touch "$RESULTS"
echo "---- run $(date -u +%FT%TZ) parts:$PARTS" >>"$RESULTS"
failures=0

say() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
pass() { printf 'PASS %s\n' "$*" | tee -a "$RESULTS" >&2; }
fail() { printf 'FAIL %s\n' "$*" | tee -a "$RESULTS" >&2; failures=$((failures + 1)); }
check() { # check <name> <command...>: PASS when the command succeeds
  local name="$1"; shift
  if "$@" >>"$LOGS/checks.log" 2>&1; then pass "$name"; else fail "$name"; fi
}
expect_rc() { # expect_rc <name> <want> <got>
  if [ "$3" = "$2" ]; then pass "$1 (exit $3)"; else fail "$1 (exit $3, expected $2)"; fi
}
py() { python3 -c "$@"; }
jget() { py "import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2], {'d': d}))" "$1" "$2"; }
part() { case "$PARTS" in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

STACK_UP=""
cleanup() {
  if [ -n "$STACK_UP" ] && [ -z "${MIP0018_E2E_KEEP:-}" ]; then
    MIP0018_KEEP_LOGS=1 "$repo/docker/local-stack/down.sh" >>"$LOGS/stack.log" 2>&1 || true
    if [ -d "$repo/docker/local-stack/.state" ]; then cp -R "$repo/docker/local-stack/.state" "$LOGS/stack-logs" 2>/dev/null || true; fi
    say "stack removed"
  fi
}
trap cleanup EXIT

# ------------------------------------------------------------------------------------------------------------ stack
if [ -n "${MIP0018_E2E_REUSE_STACK:-}" ] && [ -f "$repo/docker/local-stack/ports.env" ]; then
  say "reusing the running local stack (MIP0018_E2E_REUSE_STACK; it is left running)"
else
  say "starting the local stack"
  "$repo/docker/local-stack/up.sh" >>"$LOGS/stack.log" 2>&1
  STACK_UP=1
fi
# shellcheck disable=SC1091
. "$repo/docker/local-stack/ports.env"
NET="$MIP0018_STACK_NETWORK"
ENV_NET="-e MIP0018_INDEXER_URL=$MIP0018_INDEXER_URL_IN_NETWORK -e MIP0018_NODE_URL=$MIP0018_NODE_URL_IN_NETWORK -v $E2E:/e2e"
ENV_SIGN="$ENV_NET -e MIP0018_PROOF_SERVER_URL=$MIP0018_PROOF_SERVER_URL_IN_NETWORK -e MIP0018_WALLET_PROOF_SERVER_URL=$MIP0018_WALLET_PROOF_SERVER_URL_IN_NETWORK"
pass "stack up ($MIP0018_STACK_PROJECT)"

cli() { # cli <log name> <mip0018 args...> — wallet-free container
  local name="$1"; shift
  MIP0018_DOCKER_NETWORK="$NET" MIP0018_DOCKER_ENV="$ENV_NET" "$repo/docker/run.sh" mip0018 -- "$@" </dev/null >"$LOGS/$name.out" 2>"$LOGS/$name.err"
}
signer() { # signer <log name> <mip0018 args...> — signer container (secrets read-only, state read-write)
  local name="$1"; shift
  MIP0018_DOCKER_NETWORK="$NET" MIP0018_SECRET_DIR="$SECRETS" MIP0018_STATE_DIR="$STATE" \
    MIP0018_DOCKER_ENV="$ENV_SIGN" "$repo/docker/signer.sh" mip0018 -- "$@" </dev/null >"$LOGS/$name.out" 2>"$LOGS/$name.err"
}
A="--network undeployed --dev-genesis-wallet --wallet-cache /run/mip0018/state/a.wallet-cache"

# wallet B (C09's non-owner) — funded once
if [ ! -f "$SECRETS/b.seed" ] || [ ! -f "$E2E/b.funded" ]; then
  say "funding wallet B"
  rc=0; "$repo/docker/local-stack/fund.sh" "$SECRETS/b.seed" 1000 </dev/null >"$LOGS/fund-b.out" 2>"$LOGS/fund-b.err" || rc=$?
  expect_rc "fund.sh: wallet B funded and registered for DUST" 0 "$rc"
  if [ "$rc" = 0 ]; then touch "$E2E/b.funded"; fi
fi

EXAMPLES="minimal fungible-token native-shielded native-unshielded multi-kind token-family"
meta_of() { if [ "$1" = minimal ]; then echo "examples/minimal/metadata.json"; else echo "examples/openzeppelin/$1/metadata.json"; fi; }

# ---------------------------------------------------------------------------------- A: deploy-and-publish per example
if part A; then
  for ex in $EXAMPLES; do
    say "A: deploy-and-publish --example $ex"
    rc=0; signer "dap-$ex" deploy-and-publish $A --example "$ex" --record "/e2e/dap/$ex.json" || rc=$?
    expect_rc "A $ex: deploy-and-publish (compile with keys if needed, deploy, metadata.json steps, verify each emission)" 0 "$rc"
    check "A $ex: every record step completed, one deploy" py "
import json; r=json.load(open('$DAP/$ex.json')); s=r['steps']
assert all(x['state']=='completed' for x in s), [(x['id'],x['state']) for x in s]
assert [x['kind'] for x in s].count('deploy')==1 and r['contract']['address']
"
    # the last emitting step, verified again on its own with the exact payloads of metadata.json
    meta="$(meta_of "$ex")"
    last="$(py "import json; m=json.load(open('$repo/$meta')); print([s['id'] for s in m['steps'] if s['events']][-1])")"
    py "import json; m=json.load(open('$repo/$meta')); s=[s for s in m['steps'] if s['id']=='$last'][0]
json.dump([{'result':'accept','payload':e['payload']} for e in s['events']], open('$DAP/$ex.expect-$last.json','w'))"
    rc=0; cli "dap-verify-$ex" verify --network undeployed --record "/e2e/dap/$ex.json" --step "$last" --expect "@/e2e/dap/$ex.expect-$last.json" || rc=$?
    expect_rc "A $ex: verify $last (event = log op of the raw tx, node block, finality, exact payload)" 0 "$rc"
    rc=0; cli "dap-list-$ex" list --network undeployed --record "/e2e/dap/$ex.json" --expect "@$meta" --json || rc=$?
    expect_rc "A $ex: list --expect <metadata.json expected state>" 0 "$rc"
    check "A $ex: list matched (expectation ok)" test "$(jget "$LOGS/dap-list-$ex.out" 'd["expectation"]["ok"]')" = True
  done
  rc=0; signer dap-again deploy-and-publish $A --example multi-kind --record /e2e/dap/multi-kind.json || rc=$?
  expect_rc "A: deploy-and-publish re-run on multi-kind (every step already completed, nothing submitted)" 0 "$rc"
  check "A: the re-run added no transaction" py "
import json; r=json.load(open('$DAP/multi-kind.json')); assert len(r['steps'])==5 and all(x['state']=='completed' for x in r['steps'])"
  rc=0; signer dap-bad-meta deploy-and-publish $A --example native-shielded --record /e2e/dap/bad.json \
    --metadata '{"domainSep":"0x6d69702d303031383a6578616d706c653a736869656c64656400000000000000","kind":1,"name":"Other","symbol":"ASHD","decimals":6}' || rc=$?
  expect_rc "A: --metadata the contract cannot emit is refused before anything runs" 1 "$rc"
  check "A: the refused run created no record" test ! -e "$DAP/bad.json"
fi

# ------------------------------------------------------------------------------------------ B: walkthrough lifecycle
if part B; then
  say "B: rename / withdraw / withdraw again / revive on the fungible token"
  FT=/e2e/dap/fungible-token.json
  FTM=examples/openzeppelin/fungible-token/metadata.json
  for i in 0 1 2 3; do
    py "import json; m=json.load(open('$repo/$FTM')); json.dump(m['lifecycle'][$i]['expected'], open('$DAP/ft-after-$i.json','w'))"
  done
  rc=0; signer wt-rename publish $A --record $FT --circuit setMetadata --args '[{"$utf8":"Acme Bars"},{"$utf8":"ABAR"}]' --step rename || rc=$?
  expect_rc "B rename (setMetadata Acme Bars / ABAR)" 0 "$rc"
  rc=0; cli wt-list-rename list --network undeployed --record $FT --expect @/e2e/dap/ft-after-0.json || rc=$?
  expect_rc "B list after rename = metadata.json lifecycle[rename]" 0 "$rc"
  rc=0; signer wt-withdraw publish $A --record $FT --circuit withdrawMetadata --step withdraw || rc=$?
  expect_rc "B withdraw (tombstone)" 0 "$rc"
  rc=0; cli wt-list-withdraw list --network undeployed --record $FT --expect @/e2e/dap/ft-after-1.json || rc=$?
  expect_rc "B list after withdraw (hidden, no fields, no group)" 0 "$rc"
  rc=0; signer wt-withdraw-skip publish $A --record $FT --circuit withdrawMetadata --step withdraw-again-skipped || rc=$?
  expect_rc "B withdraw again WITHOUT --force" 0 "$rc"
  check "B the repeated tombstone was skipped by the before-check (no transaction)" py "
import json; s=[x for x in json.load(open('$DAP/fungible-token.json'))['steps'] if x['id']=='withdraw-again-skipped'][0]; assert 'tx' not in s and s.get('skipped'), s"
  rc=0; signer wt-withdraw-again publish $A --record $FT --circuit withdrawMetadata --step withdraw-again --force || rc=$?
  expect_rc "B withdraw again with --force (emitted)" 0 "$rc"
  rc=0; cli wt-list-withdraw-again list --network undeployed --record $FT --expect @/e2e/dap/ft-after-2.json || rc=$?
  expect_rc "B list after the repeated tombstone (unchanged)" 0 "$rc"
  rc=0; signer wt-revive publish $A --record $FT --circuit publishMetadata --step revive || rc=$?
  expect_rc "B revive (publishMetadata again)" 0 "$rc"
  rc=0; cli wt-list-revive list --network undeployed --record $FT --expect @/e2e/dap/ft-after-3.json --history || rc=$?
  expect_rc "B list after revive = the published values again" 0 "$rc"
  rc=0; cli wt-verify-revive verify --network undeployed --record $FT --step revive || rc=$?
  expect_rc "B verify the revive" 0 "$rc"

  say "B: create-and-destroy on the minimal example"
  MN=/e2e/dap/minimal.json
  rc=0; signer wt-remove remove-circuit $A --record $MN --circuit publishMetadata || rc=$?
  expect_rc "B remove-circuit publishMetadata (VerifierKeyRemove v4)" 0 "$rc"
  rc=0; signer wt-publish-again publish $A --record $MN --circuit publishMetadata --step publish-again --force || rc=$?
  expect_rc "B publish after the key removal is refused before submission" 1 "$rc"
  check "B refused: no transaction in the step" py "
import json; s=[x for x in json.load(open('$DAP/minimal.json'))['steps'] if x['id']=='publish-again'][0]; assert 'tx' not in s, s"
  rc=0; cli wt-list-minimal list --network undeployed --record $MN --expect @examples/minimal/metadata.json || rc=$?
  expect_rc "B list minimal: still exactly the A1 metadata" 0 "$rc"
fi

# ------------------------------------------------------------------------------------------- C: S5 case folders, local
run_case() { # run_case <ID>
  local id="$1" cj="$repo/deployments/stagenet/cases/$1/case.json" line i sid runner want out args a rc
  mkdir -p "$CASES/$id"
  say "C: case $id"
  while IFS= read -r line; do
    i="$(printf '%s' "$line" | cut -f1)"; sid="$(printf '%s' "$line" | cut -f2)"; runner="$(printf '%s' "$line" | cut -f3)"
    want="$(printf '%s' "$line" | cut -f4)"; out="$(printf '%s' "$line" | cut -f5)"
    args=()
    while IFS= read -r -d '' a; do args[${#args[@]}]="$a"; done < <(python3 "$here/case.py" argv "$cj" "$i" "$E2E")
    rc=0
    if [ "$runner" = signer ]; then signer "case-$id-$sid" ${args[@]+"${args[@]}"} || rc=$?
    else cli "case-$id-$sid" ${args[@]+"${args[@]}"} || rc=$?; fi
    if [ -n "$out" ] && [ -f "$LOGS/case-$id-$sid.out" ]; then cp "$LOGS/case-$id-$sid.out" "$CASES/$id/$out"; fi
    expect_rc "C $id $sid" "$want" "$rc"
  done < <(python3 "$here/case.py" steps "$cj")
}
if part C; then
  for id in ${MIP0018_E2E_CASES:-C01 C02 C03 C04 C05 C06 C07 C08 C09 C10 IDX}; do run_case "$id"; done
fi

# ------------------------------------------------------------------------------------- D: recheck + secret scan
if part D; then
  for id in ${MIP0018_E2E_CASES:-C01 C02 C03 C04 C05 C06 C07 C08 C09 C10 IDX}; do
    rc=0; cli "recheck-$id" recheck --network undeployed --case "deployments/stagenet/cases/$id" --out "/e2e/cases/$id" || rc=$?
    expect_rc "D recheck $id ($(tail -1 "$LOGS/recheck-$id.out" 2>/dev/null))" 0 "$rc"
  done
  say "secret scan"
  check "D no secret value in any log, record, observation or index state" py "
import json,glob,os
secrets=set()
secrets.add(open('$SECRETS/b.seed').read().strip().lower())
def walk(v):
  if isinstance(v,dict):
    if set(v)=={'\$bytes'}: secrets.add(v['\$bytes'].lower()); return
    for x in v.values(): walk(x)
  elif isinstance(v,list):
    for x in v: walk(x)
  elif isinstance(v,str) and len(v)>=32: secrets.add(v.lower())
for f in glob.glob('$STATE/*private-state*.json'):
  d=json.load(open(f)); walk(d.get('signingKeys',{})); walk(d.get('states',{}))
secrets={s for s in secrets if len(s)>=32}
assert secrets, 'no secret values collected'
hits=[]
for root in ['$LOGS','$DAP','$CASES']:
  for dp,_,fs in os.walk(root):
    for fn in fs:
      p=os.path.join(dp,fn); t=open(p,errors='ignore').read().lower()
      for s in secrets:
        if s in t: hits.append((p,s[:8]))
assert not hits, hits
print('secret values checked:', len(secrets))
"
  check "D private-state and wallet-cache files are mode 0600" py "import os,stat,glob; fs=glob.glob('$STATE/*'); assert fs and all(stat.S_IMODE(os.stat(f).st_mode)==0o600 for f in fs), [(f,oct(os.stat(f).st_mode)) for f in fs]"
fi

say "done: $failures failure(s)"
exit "$failures"
