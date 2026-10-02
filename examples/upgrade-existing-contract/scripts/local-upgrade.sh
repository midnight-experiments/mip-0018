#!/usr/bin/env bash
# Local end-to-end proof of the upgrade template (MIP-0018 "Existing contracts") on docker/local-stack (official
# midnightntwrk images only), with the mip0018 CLI:
#
#   MIP0018_DOCKER_PREFIX=<prefix> MIP0018_E2E_DIR=<empty dir outside the repo> \
#     examples/upgrade-existing-contract/scripts/local-upgrade.sh
#
#   1. compile LegacyToken and the upgrade-only LegacyTokenMetadata with keys (Compact 0.35.0, --feature-zkir-v3)
#   2. deploy LegacyToken (maintenance authority = the deploy-time key), mint 1000 shielded coins to wallet A, record
#      the color wallet A holds and a wallet-free snapshot of the contract (entry points, authority, ledger data hash)
#   3. NEGATIVE wrong signer: the insert signed by a random key is refused before submission, and — forced — rejected
#      by the node; nothing changes
#   4. mip0018 upgrade: preflight → VerifierKeyInsert(publishMetadata, v4) → publishMetadata() call
#   5. same address; mint key unchanged; ledger data unchanged; verify (kind-1 expectation) → 0; list → the identity
#      with color = the pre-upgrade coin's color; wallet A still holds 1000 of it; mint scanner + lookup resolve that
#      color to the metadata published after the upgrade
#   6. NEGATIVE no overwrite: re-insert of the same circuit (same key, and another build's key) refused before
#      submission and — forced — refused by the ledger; the key and the counter stay; re-run/publish are idempotent
#   7. secret scan of every log and record
#
# Wallet A = the local dev chain's public genesis wallet (no secret). Prints PASS/FAIL lines (also $MIP0018_E2E_DIR/
# results.txt) and $MIP0018_E2E_DIR/summary.json (ids, fees, colors); removes the stack unless MIP0018_E2E_KEEP=1.
# Exit = number of failures. bash 3.2 compatible.
set -euo pipefail

repo="$(cd "$(dirname "$0")/../../.." && pwd -P)"
: "${MIP0018_DOCKER_PREFIX:?set MIP0018_DOCKER_PREFIX (e.g. mips-00013-s6-<rand>)}"
: "${MIP0018_E2E_DIR:?set MIP0018_E2E_DIR to an empty directory outside the repository}"
export MIP0018_DOCKER_PREFIX
E2E="$(cd "$MIP0018_E2E_DIR" && pwd -P)"
case "$E2E/" in "$repo"/*) echo "MIP0018_E2E_DIR must be outside the repository" >&2; exit 2 ;; esac

SECRETS="$E2E/secrets"; STATE="$E2E/state"; RECORDS="$E2E/records"; LOGS="$E2E/logs"; INDEX="$E2E/index"
mkdir -p "$SECRETS" "$STATE" "$RECORDS" "$LOGS" "$INDEX"
chmod 700 "$SECRETS" "$STATE"
RESULTS="$E2E/results.txt"
: >"$RESULTS"
failures=0

say() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
pass() { printf 'PASS %s\n' "$*" | tee -a "$RESULTS" >&2; }
fail() { printf 'FAIL %s\n' "$*" | tee -a "$RESULTS" >&2; failures=$((failures + 1)); }
check() { # check <name> <command...>
  local name="$1"; shift
  if "$@" >>"$LOGS/checks.log" 2>&1; then pass "$name"; else fail "$name"; fi
}
expect_rc() { if [ "$3" = "$2" ]; then pass "$1 (exit $3)"; else fail "$1 (exit $3, expected $2)"; fi; }
py() { python3 -c "$@"; }
jget() { py "import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2], {'d': d}))" "$1" "$2"; }

EX="examples/upgrade-existing-contract"
STACK_UP=""
cleanup() {
  if [ -n "$STACK_UP" ] && [ -z "${MIP0018_E2E_KEEP:-}" ]; then
    MIP0018_KEEP_LOGS=1 "$repo/docker/local-stack/down.sh" >>"$LOGS/stack.log" 2>&1 || true
    if [ -d "$repo/docker/local-stack/.state" ]; then cp -R "$repo/docker/local-stack/.state" "$LOGS/stack-logs" 2>/dev/null || true; fi
    say "stack removed"
  fi
}
trap cleanup EXIT

# --------------------------------------------------------------------------------------------------------- compile
say "compiling LegacyToken and LegacyTokenMetadata with keys"
# (network: key generation downloads the public ZK parameters once into the zk-params volume)
rc=0; "$repo/docker/run.sh" exec "npm run -s compile -w $EX && npm run -s check-layout -w $EX" >"$LOGS/compile.out" 2>"$LOGS/compile.err" || rc=$?
expect_rc "compile both contracts with keys; layout check OK" 0 "$rc"

# ----------------------------------------------------------------------------------------------------------- stack
if [ -n "${MIP0018_E2E_REUSE_STACK:-}" ] && [ -f "$repo/docker/local-stack/ports.env" ]; then
  say "reusing the running local stack (left running)"
else
  say "starting the local stack"
  "$repo/docker/local-stack/up.sh" >>"$LOGS/stack.log" 2>&1
  STACK_UP=1
fi
# shellcheck disable=SC1091
. "$repo/docker/local-stack/ports.env"
NET="$MIP0018_STACK_NETWORK"
IDX="http://127.0.0.1:$MIP0018_INDEXER_PORT/api/v4/graphql"
ENV_NET="-e MIP0018_INDEXER_URL=$MIP0018_INDEXER_URL_IN_NETWORK -e MIP0018_NODE_URL=$MIP0018_NODE_URL_IN_NETWORK -v $E2E:/e2e"
ENV_SIGN="$ENV_NET -e MIP0018_PROOF_SERVER_URL=$MIP0018_PROOF_SERVER_URL_IN_NETWORK -e MIP0018_WALLET_PROOF_SERVER_URL=$MIP0018_WALLET_PROOF_SERVER_URL_IN_NETWORK"
pass "stack up ($MIP0018_STACK_PROJECT)"

cli() { local name="$1"; shift
  MIP0018_DOCKER_NETWORK="$NET" MIP0018_DOCKER_ENV="$ENV_NET" "$repo/docker/run.sh" mip0018 -- "$@" >"$LOGS/$name.out" 2>"$LOGS/$name.err"
}
signer() { local name="$1"; shift
  MIP0018_DOCKER_NETWORK="$NET" MIP0018_SECRET_DIR="$SECRETS" MIP0018_STATE_DIR="$STATE" \
    MIP0018_DOCKER_ENV="$ENV_SIGN" "$repo/docker/signer.sh" mip0018 -- "$@" >"$LOGS/$name.out" 2>"$LOGS/$name.err"
}
inspect() { local name="$1"; shift # wallet-free contract snapshot
  MIP0018_DOCKER_NETWORK="$NET" MIP0018_DOCKER_ENV="$ENV_NET" "$repo/docker/run.sh" exec \
    "node $EX/scripts/inspect.ts --network undeployed --contract $1 --ledger $EX/managed/LegacyToken --ledger $EX/managed/LegacyTokenMetadata" \
    >"$LOGS/$name.json" 2>"$LOGS/$name.err"
}
gql() { curl -fsS -m 20 -H 'Content-Type: application/json' -d "$1" "$IDX"; }
events_of() { gql "{\"query\":\"{ contractEvents(filter:{contractAddress:\\\"$1\\\", types:[MISC]}, limit:500) { id } }\"}" | py 'import json,sys; print(len(json.load(sys.stdin)["data"]["contractEvents"]))'; }
step_py() { # step_py <step id> <python statements using s (the step record)>
  py "import json
s=[x for x in json.load(open('$RECORDS/legacy.json'))['steps'] if x['id']=='$1'][0]
$2"
}

A="--network undeployed --dev-genesis-wallet"
REC="/e2e/records/legacy.json"
UP="--record $REC --source $EX/upgrade --circuit publishMetadata"
DS="0x$(printf '5e%.0s' $(seq 1 32))"

# ---------------------------------------------------------------------------------------------- deploy and mint
rc=0; signer wallet-a wallet status $A --json || rc=$?
expect_rc "wallet status (A)" 0 "$rc"
CPK_A="$(jget "$LOGS/wallet-a.out" 'd["coinPublicKey"]')"

say "deploy LegacyToken (no MIP-0018 circuit)"
rc=0; signer legacy-deploy deploy $A --adapter "$EX/legacy/mip0018.adapter.ts" --args "[\"$DS\"]" --record "$REC" || rc=$?
expect_rc "deploy LegacyToken" 0 "$rc"
ADDR="$(jget "$RECORDS/legacy.json" 'd["contract"]["address"]')"
rc=0; signer legacy-mint call $A --record "$REC" --circuit mint --args "[{\"bytes\":\"0x$CPK_A\"},1000,\"0x$(printf '01%.0s' $(seq 1 32))\"]" || rc=$?
expect_rc "owner mints 1000 shielded coins to wallet A" 0 "$rc"
check "the mint emitted no Misc event" test "$(events_of "$ADDR")" = 0

rc=0; signer wallet-a-before wallet status $A --json || rc=$?
expect_rc "wallet status (A) after the mint" 0 "$rc"
COLOR="$(MIP0018_DOCKER_NETWORK=none "$repo/docker/run.sh" exec "node packages/cli/test/e2e/color.ts $DS $ADDR" 2>/dev/null | tail -1)"
check "wallet A holds 1000 coins of color rawTokenType(domainSep, address) = $COLOR" py "
import json; b=json.load(open('$LOGS/wallet-a-before.out'))['shieldedBalances']; assert b.get('$COLOR')=='1000', b"
rc=0; inspect before "$ADDR" || rc=$?
expect_rc "wallet-free snapshot before the upgrade" 0 "$rc"
check "before: entry points = [mint]; one-key authority, threshold 1, counter 0" py "
import json; d=json.load(open('$LOGS/before.json'))
assert sorted(d['operations'])==['mint'] and d['operations']['mint'], d['operations']
assert d['maintenanceAuthority']=={'committeeSize':1,'threshold':1,'counter':'0'}, d['maintenanceAuthority']"

# ------------------------------------------------------------------------------------ negative: wrong signer
say "negative: VerifierKeyInsert signed by a key outside the committee"
MIP0018_DOCKER_NETWORK=none MIP0018_DOCKER_ENV="-v $E2E:/e2e" "$repo/docker/run.sh" exec \
  "node -e \"const l=require('@midnightntwrk/ledger-v9'); require('fs').writeFileSync('/e2e/secrets/wrong.key', JSON.stringify(l.sampleSigningKey()), {mode: 0o600})\"" \
  >"$LOGS/wrong-key.out" 2>"$LOGS/wrong-key.err"
rc=0; signer wrong-signer upgrade $A $UP --maintenance-key-file /run/mip0018/secrets/wrong.key --no-call --step wrong-signer || rc=$?
expect_rc "upgrade signed by another key: refused before submission" 1 "$rc"
check "wrong signer: the reason is the committee, no transaction" step_py wrong-signer:insert "
assert s['state']=='pending' and 'tx' not in s, s
assert \"not in the contract's committee\" in open('$LOGS/wrong-signer.err').read()"
rc=0; signer wrong-signer-forced upgrade $A $UP --maintenance-key-file /run/mip0018/secrets/wrong.key --no-call --step wrong-signer-forced --force || rc=$?
expect_rc "upgrade signed by another key, forced: rejected by the chain" 1 "$rc"
check "wrong signer forced: the step failed and nothing was inserted" step_py wrong-signer-forced:insert "
assert s['state']=='failed', s
print('error:', s.get('error','')[:400]); print('inclusion:', s.get('inclusion'))"
rc=0; inspect after-wrong "$ADDR" || rc=$?
check "after the rejected insert: still only mint, counter 0, same data" py "
import json; a=json.load(open('$LOGS/before.json')); b=json.load(open('$LOGS/after-wrong.json'))
assert b['operations']==a['operations'] and b['maintenanceAuthority']==a['maintenanceAuthority'] and b['dataSha256']==a['dataSha256'], b"

# ------------------------------------------------------------------------------------------------------ upgrade
say "mip0018 upgrade: VerifierKeyInsert(publishMetadata, v4) by the maintenance authority, then publishMetadata()"
rc=0; signer upgrade upgrade $A $UP || rc=$?
expect_rc "mip0018 upgrade (preflight, insert, call)" 0 "$rc"
check "upgrade steps completed: insert (no skip) and call with one expected event" py "
import json; r=json.load(open('$RECORDS/legacy.json'))
i=[x for x in r['steps'] if x['id']=='verifier-key-insert:publishMetadata'][0]
c=[x for x in r['steps'] if x['kind']=='call' and x['circuit']=='publishMetadata'][0]
assert i['state']=='completed' and i['tx'] and not i.get('skipped'), i
assert c['state']=='completed' and len(c['expectedEvents'])==1, c
u=r['contract']['upgrades'][0]; assert u['circuit']=='publishMetadata' and u['slot']=='v4' and u['checks']['ok'], u"
PUB_TX="$(jget "$RECORDS/legacy.json" '[x for x in d["steps"] if x["kind"]=="call" and x["circuit"]=="publishMetadata"][0]["tx"]["hash"]')"
INS_TX="$(jget "$RECORDS/legacy.json" '[x for x in d["steps"] if x["id"]=="verifier-key-insert:publishMetadata"][0]["tx"]["hash"]')"
rc=0; inspect after "$ADDR" || rc=$?
VK_UP="$(MIP0018_DOCKER_NETWORK=none "$repo/docker/run.sh" exec "sha256sum $EX/managed/LegacyTokenMetadata/keys/publishMetadata.verifier" 2>/dev/null | tail -1 | cut -d' ' -f1)"
check "after: entry points = [mint, publishMetadata]; mint key unchanged; publishMetadata key = the upgrade build's; counter 1; ledger data unchanged" py "
import json; a=json.load(open('$LOGS/before.json')); b=json.load(open('$LOGS/after.json'))
assert sorted(b['operations'])==['mint','publishMetadata'], b['operations']
assert b['operations']['mint']==a['operations']['mint']
assert b['operations']['publishMetadata']=='$VK_UP', (b['operations'], '$VK_UP')
assert b['maintenanceAuthority']=={'committeeSize':1,'threshold':1,'counter':'1'}, b['maintenanceAuthority']
assert b['dataSha256']==a['dataSha256'], 'ledger data changed'
assert b['decoded']['$EX/managed/LegacyToken']==b['decoded']['$EX/managed/LegacyTokenMetadata']"
check "exactly one Misc event on the contract" test "$(events_of "$ADDR")" = 1

EXPECT="{\"metadata\":{\"domainSep\":\"$DS\",\"kind\":1,\"name\":\"Legacy Token\",\"symbol\":\"LGCY\",\"decimals\":6}}"
rc=0; cli verify verify --network undeployed --contract "$ADDR" --tx "$PUB_TX" --expect "$EXPECT" --json || rc=$?
expect_rc "verify the publish (bound to the original address, kind-1 expectation)" 0 "$rc"
rc=0; cli list list --network undeployed --contract "$ADDR" --json || rc=$?
expect_rc "list the contract" 0 "$rc"
check "list: one visible kind-1 identity (original address, domainSep 0x5e…) with color = the pre-upgrade coin's" py "
import json; d=json.load(open('$LOGS/list.out')); i=d['identities']
assert len(i)==1, i; x=i[0]
assert x['visible'] and x['kind']==1 and x['contractAddress']=='$ADDR' and x['domainSep']=='${DS#0x}', x
assert x['color']=='$COLOR', (x['color'], '$COLOR')
c=x['common']; assert c['name']=='Legacy Token' and c['symbol']=='LGCY' and str(c['decimals'])=='6', c"
rc=0; signer wallet-a-after wallet status $A --json || rc=$?
check "wallet A still holds exactly 1000 of that color" py "
import json; b=json.load(open('$LOGS/wallet-a-after.out'))['shieldedBalances']; assert b.get('$COLOR')=='1000', b"

FROM=0
if gql '{"query":"{ block(offset:{height:0}) { height } }"}' | grep -q '"block":null'; then FROM=1; fi
rc=0; cli index index --network undeployed --from-height "$FROM" --state /e2e/index --json || rc=$?
expect_rc "mint scanner from $FROM" 0 "$rc"
INS_H="$(jget "$RECORDS/legacy.json" '[x for x in d["steps"] if x["id"]=="verifier-key-insert:publishMetadata"][0]["inclusion"]["height"]')"
check "scanner: the color was minted (shielded, 1000) by this contract under 0x5e… before the insert (height $INS_H)" py "
import json; s=json.load(open('$INDEX/index-state.json')); e=s['colors']['$COLOR']
assert e['contractAddress']=='$ADDR' and e['domainSep']=='${DS#0x}', e
assert e['shielded']['mints']==1 and e['shielded']['amount']=='1000' and e['shielded']['firstMint']['height'] < $INS_H, e
assert len(s['events']['$ADDR'])==1"
rc=0; cli lookup lookup --color "$COLOR" --state /e2e/index --network undeployed --json || rc=$?
expect_rc "lookup the held color" 0 "$rc"
check "lookup: the pre-upgrade coin's color resolves to the metadata published after the upgrade" py "
import json; r=json.load(open('$LOGS/lookup.out'))['resolved']; assert len(r)==1 and r[0]['kind']==1 and r[0]['contractAddress']=='$ADDR', r
m=r[0]['metadata']['common']; assert m['name']=='Legacy Token' and m['symbol']=='LGCY', m"

# ------------------------------------------------------------------------------------- negative: no overwrite
say "negative: re-insert the same circuit name"
rc=0; signer rerun upgrade $A $UP || rc=$?
expect_rc "the same upgrade command again (resumes: every step already completed)" 0 "$rc"
rc=0; signer again upgrade $A $UP --step again || rc=$?
expect_rc "a new upgrade run (new step ids)" 0 "$rc"
check "new run: insert skipped (same key already there), no transaction" step_py again:insert "
assert s['state']=='completed' and s.get('skipped') and 'tx' not in s, s"
check "new run: call skipped (metadata already present), no transaction" step_py again:call "
assert s['state']=='completed' and s.get('skipped') and 'tx' not in s, s"
rc=0; signer same-forced upgrade $A $UP --no-call --step same-forced --force || rc=$?
expect_rc "re-insert the same key, forced: refused by the ledger" 1 "$rc"
check "same key forced: included but failed (no overwrite)" step_py same-forced:insert "
assert s['state']=='failed' and s.get('tx'), s; print('inclusion:', s.get('inclusion')); print('error:', s.get('error','')[:300])"
OW="$EX/test/fixtures/overwrite"
rc=0; signer other-key upgrade $A --record "$REC" --source "$OW" --circuit publishMetadata --no-call --step other-key || rc=$?
expect_rc "insert ANOTHER build's publishMetadata key: refused before submission" 1 "$rc"
check "other key: refused by the before-check (never overwrites), no transaction" step_py other-key:insert "
assert s['state']=='pending' and 'tx' not in s, s
assert 'never overwrites' in open('$LOGS/other-key.err').read()"
rc=0; signer other-key-forced upgrade $A --record "$REC" --source "$OW" --circuit publishMetadata --no-call --step other-key-forced --force || rc=$?
expect_rc "insert another key, forced: refused by the ledger" 1 "$rc"
check "other key forced: included but failed" step_py other-key-forced:insert "
assert s['state']=='failed' and s.get('tx'), s; print('inclusion:', s.get('inclusion')); print('error:', s.get('error','')[:300])"
rc=0; inspect after-overwrite "$ADDR" || rc=$?
check "after both overwrite attempts: publishMetadata key and counter unchanged, data unchanged, one event" py "
import json; a=json.load(open('$LOGS/after.json')); b=json.load(open('$LOGS/after-overwrite.json'))
assert b['operations']==a['operations'] and b['maintenanceAuthority']==a['maintenanceAuthority'] and b['dataSha256']==a['dataSha256'], b"
check "still exactly one Misc event" test "$(events_of "$ADDR")" = 1
check "the record still names the upgrade build (failed inserts are not recorded as upgrades)" py "
import json; u=json.load(open('$RECORDS/legacy.json'))['contract']['upgrades']
assert len(u)==1 and u[0]['contract']=='LegacyTokenMetadata', u"
rc=0; signer republish publish $A --record "$REC" --circuit publishMetadata --step republish || rc=$?
expect_rc "publish (through the upgrade build found in the record) of the same metadata" 0 "$rc"
check "republish: skipped by the before-check (already present), no transaction" step_py republish "
assert s['state']=='completed' and s.get('skipped') and 'tx' not in s, s"

# ------------------------------------------------------------------------------------------------------ summary
py "
import json
r=json.load(open('$RECORDS/legacy.json'))
steps={s['id']:{k:s.get(k) for k in ['kind','state','skipped','error']} | {'tx': (s.get('tx') or {}).get('hash'), 'height': (s.get('inclusion') or {}).get('height'), 'status': (s.get('inclusion') or {}).get('status'), 'feeSpeck': (s.get('inclusion') or {}).get('fee')} for s in r['steps']}
json.dump({'contract': '$ADDR', 'domainSep': '$DS', 'color': '$COLOR', 'insertTx': '$INS_TX', 'publishTx': '$PUB_TX', 'verifierKeySha256': '$VK_UP', 'steps': steps, 'upgrades': r['contract'].get('upgrades')}, open('$E2E/summary.json','w'), indent=2)
"

# ------------------------------------------------------------------------------------------------------ secrets
check "no secret value (maintenance keys, owner secrets, wrong key) in any log or record" py "
import json,glob,os
secrets=set()
def walk(v):
  if isinstance(v,dict):
    if set(v)=={'\$bytes'}: secrets.add(v['\$bytes'].lower()); return
    for x in v.values(): walk(x)
  elif isinstance(v,list):
    for x in v: walk(x)
  elif isinstance(v,str) and len(v)>=32: secrets.add(v.lower())
for f in glob.glob('$STATE/*.json'):
  d=json.load(open(f)); walk(d.get('signingKeys',{})); walk(d.get('states',{}))
secrets.add(json.load(open('$SECRETS/wrong.key'))['value'].lower())
secrets={s for s in secrets if len(s)>=32}
assert len(secrets)>=3, secrets
hits=[]
for root in ['$LOGS','$RECORDS','$INDEX']:
  for dp,_,fs in os.walk(root):
    for fn in fs:
      t=open(os.path.join(dp,fn),errors='ignore').read().lower()
      hits += [(fn,s[:8]) for s in secrets if s in t]
assert not hits, hits
print('secret values checked:', len(secrets))"
check "private-state file is mode 0600" py "import os,stat,glob; fs=glob.glob('$STATE/*.json'); assert fs and all(stat.S_IMODE(os.stat(f).st_mode)==0o600 for f in fs)"

say "done: $failures failure(s); summary in $E2E/summary.json"
exit "$failures"
