#!/usr/bin/env bash
# End-to-end test of the mip0018 CLI on a local undeployed chain (docker/local-stack, official images only).
#
#   MIP0018_DOCKER_PREFIX=<prefix> MIP0018_E2E_DIR=<empty dir outside the repo> packages/cli/test/e2e/local-e2e.sh
#
# Needs the compiled contracts (full keys): docker/run.sh compile:spike; docker/run.sh exec 'npm run compile -w
# test-contracts/scanner-mints'. Starts the stack (up.sh), runs every case below, prints PASS/FAIL lines (also in
# $MIP0018_E2E_DIR/results.txt) and removes the stack (down.sh) unless MIP0018_E2E_KEEP=1 (MIP0018_E2E_REUSE_STACK=1
# runs against an already running stack and leaves it). Exit = number of failures.
#
# Cases: S0 spike through the package · wallet status / register-dust · deploy + publish with a crash right after
# each submission and a resume (exactly one deploy, one event) · verify / list · re-publish skipped (already
# present) · remove-circuit, then publish refused · deploy-and-publish of an example adapter · OZ Ownable token:
# owner mint + publish, non-owner publish refused before submission · native mints (shielded + unshielded) · mint
# scanner from height 0, killed mid-scan and resumed (identical table) · lookup (kinds 1, 2, unknown, kind 3) ·
# identity guards · secret scan of every log, record and state.
#
# Wallets: A = the dev chain's public genesis wallet; B = a fresh local test wallet funded by docker/local-stack/
# fund.sh (its hex seed stays in $MIP0018_E2E_DIR/secrets, mode 0600). bash 3.2 compatible.
set -euo pipefail

repo="$(cd "$(dirname "$0")/../../../.." && pwd -P)"
: "${MIP0018_DOCKER_PREFIX:?set MIP0018_DOCKER_PREFIX (e.g. mips-00013-s4-<rand>)}"
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
check() { # check <name> <command...>: PASS when the command succeeds
  local name="$1"; shift
  if "$@" >>"$LOGS/checks.log" 2>&1; then pass "$name"; else fail "$name"; fi
}
expect_rc() { # expect_rc <name> <want> <got>
  if [ "$3" = "$2" ]; then pass "$1 (exit $3)"; else fail "$1 (exit $3, expected $2)"; fi
}
expect_killed() { # expect_killed <name> <rc> <stderr log>: the test hook killed the process (npm may report 1 or 137)
  if [ "$2" != 0 ] && grep -q "TEST HOOK\|test hook" "$3"; then pass "$1 (exit $2)"; else fail "$1 (exit $2, no test-hook kill in $3)"; fi
}
py() { python3 -c "$@"; }

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
IDX="http://127.0.0.1:$MIP0018_INDEXER_PORT/api/v4/graphql"
ENV_NET="-e MIP0018_INDEXER_URL=$MIP0018_INDEXER_URL_IN_NETWORK -e MIP0018_NODE_URL=$MIP0018_NODE_URL_IN_NETWORK -v $E2E:/e2e"
ENV_SIGN="$ENV_NET -e MIP0018_PROOF_SERVER_URL=$MIP0018_PROOF_SERVER_URL_IN_NETWORK -e MIP0018_WALLET_PROOF_SERVER_URL=$MIP0018_WALLET_PROOF_SERVER_URL_IN_NETWORK"
pass "stack up ($MIP0018_STACK_PROJECT)"

cli() { # cli <log name> <mip0018 args...> — wallet-free container
  local name="$1"; shift
  MIP0018_DOCKER_NETWORK="$NET" MIP0018_DOCKER_ENV="$ENV_NET" "$repo/docker/run.sh" mip0018 -- "$@" >"$LOGS/$name.out" 2>"$LOGS/$name.err"
}
signer() { # signer <log name> <mip0018 args...> — signer container (secrets read-only, state read-write)
  local name="$1"; shift
  MIP0018_DOCKER_NETWORK="$NET" MIP0018_SECRET_DIR="$SECRETS" MIP0018_STATE_DIR="$STATE" \
    MIP0018_DOCKER_ENV="$ENV_SIGN ${EXTRA_ENV:-}" "$repo/docker/signer.sh" mip0018 -- "$@" >"$LOGS/$name.out" 2>"$LOGS/$name.err"
}
A="--network undeployed --dev-genesis-wallet"
B="--network undeployed --seed-file /run/mip0018/secrets/b.seed --private-state /run/mip0018/state/b-private-state.json"
gql() { curl -fsS -m 20 -H 'Content-Type: application/json' -d "$1" "$IDX"; }
events_of() { gql "{\"query\":\"{ contractEvents(filter:{contractAddress:\\\"$1\\\", types:[MISC]}, limit:500) { id } }\"}" | py 'import json,sys; print(len(json.load(sys.stdin)["data"]["contractEvents"]))'; }
jget() { py "import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2], {'d': d}))" "$1" "$2"; }

# --------------------------------------------------------------------------------------- S0 spike through the package
if [ -z "${MIP0018_E2E_SKIP_SPIKE:-}" ]; then
  say "S0 spike (spike:local) through @mip0018/midnight"
  rc=0; MIP0018_DOCKER_NETWORK="$NET" MIP0018_DOCKER_ENV="-e SPIKE_RECORD=/e2e/records/spike-local.json -v $E2E:/e2e" \
    "$repo/docker/run.sh" spike:local >"$LOGS/spike-local.out" 2>"$LOGS/spike-local.err" || rc=$?
  expect_rc "spike:local (deploy, A1 call, v4 VerifierKeyRemove, second call refused) via the package" 0 "$rc"
fi

# ------------------------------------------------------------------------------------------------------- wallets
say "funding wallet B"
rc=0; "$repo/docker/local-stack/fund.sh" "$SECRETS/b.seed" 1000 >"$LOGS/fund-b.out" 2>"$LOGS/fund-b.err" || rc=$?
expect_rc "fund.sh: wallet B funded and registered for DUST" 0 "$rc"
rc=0; signer wallet-a wallet status $A --json || rc=$?
expect_rc "wallet status (A)" 0 "$rc"
CPK_A="$(jget "$LOGS/wallet-a.out" 'd["coinPublicKey"]')"
rc=0; signer wallet-b-register wallet register-dust $B --json || rc=$?
expect_rc "wallet register-dust (B, already registered)" 0 "$rc"
check "register-dust before-check skipped (all UTxOs registered)" test "$(jget "$LOGS/wallet-b-register.out" 'd["outcome"]')" = skipped

# --------------------------------------------------------------------------- deploy + publish, crash and resume
EM="test-contracts/toolchain-spike/managed/SpikeEmitter"
say "SpikeEmitter: deploy killed right after submission"
rc=0; EXTRA_ENV="-e MIP0018_TEST_CRASH_AFTER_SUBMIT=deploy" signer em-deploy-crash deploy $A --contract "$EM" --record /e2e/records/emitter.json || rc=$?
expect_killed "deploy killed by the test hook right after submission" "$rc" "$LOGS/em-deploy-crash.err"
check "record holds the address and the submitted transaction (write-ahead)" py "import json; r=json.load(open('$RECORDS/emitter.json')); s=r['steps'][0]; assert r['contract'].get('address') and s['state']=='submitted' and s['tx']['hash'], s"
rc=0; signer em-deploy-resume deploy $A --contract "$EM" --record /e2e/records/emitter.json --json || rc=$?
expect_rc "deploy re-run (reconciles, skips)" 0 "$rc"
EM_ADDR="$(jget "$RECORDS/emitter.json" 'd["contract"]["address"]')"
check "deploy step completed after the resume" py "import json; s=json.load(open('$RECORDS/emitter.json'))['steps'][0]; assert s['state']=='completed', s"

say "SpikeEmitter: publish killed right after submission"
rc=0; EXTRA_ENV="-e MIP0018_TEST_CRASH_AFTER_SUBMIT=call" signer em-publish-crash publish $A --record /e2e/records/emitter.json --circuit publishMetadata || rc=$?
expect_killed "publish killed by the test hook right after submission" "$rc" "$LOGS/em-publish-crash.err"
rc=0; signer em-publish-resume publish $A --record /e2e/records/emitter.json --circuit publishMetadata || rc=$?
expect_rc "publish re-run (reconciles)" 0 "$rc"
check "publish step completed with the expected event observed" py "import json; s=[x for x in json.load(open('$RECORDS/emitter.json'))['steps'] if x['kind']=='call'][0]; assert s['state']=='completed' and len(s['expectedEvents'])==1, s"
check "exactly one Misc event on the emitter contract" test "$(events_of "$EM_ADDR")" = 1
PUB_TX="$(jget "$RECORDS/emitter.json" '[x for x in d["steps"] if x["kind"]=="call"][0]["tx"]["hash"]')"

A1='{"metadata":{"domainSep":"0x1111111111111111111111111111111111111111111111111111111111111111","kind":3,"name":"Acme Token","symbol":"ACME","decimals":6,"standards":["mip-0004"]}}'
rc=0; cli verify-em verify --network undeployed --contract "$EM_ADDR" --tx "$PUB_TX" --expect "$A1" || rc=$?
expect_rc "verify publish (A1 expectation)" 0 "$rc"
rc=0; cli verify-em-wrong verify --network undeployed --contract "$EM_ADDR" --tx "$PUB_TX" --expect '{"result":"reject"}' || rc=$?
expect_rc "verify with a wrong expectation" 1 "$rc"
rc=0; cli verify-unknown verify --network undeployed --contract "$EM_ADDR" --tx "$(printf 'ee%.0s' $(seq 1 32))" || rc=$?
expect_rc "verify an unknown transaction (not found)" 3 "$rc"
rc=0; cli list-em list --network undeployed --contract "$EM_ADDR" --json || rc=$?
expect_rc "list emitter" 0 "$rc"
check "list: one visible kind-3 identity with the A1 fields" py "import json; d=json.load(open('$LOGS/list-em.out')); i=d['identities']; assert len(i)==1 and i[0]['visible'] and i[0]['kind']==3 and i[0]['common']['name']=='Acme Token' and str(i[0]['common']['decimals'])=='6', i"

rc=0; signer em-publish-again publish $A --record /e2e/records/emitter.json --circuit publishMetadata --step publish-again || rc=$?
expect_rc "publish the same metadata again (new step id)" 0 "$rc"
check "before-check skipped it: no transaction, still one event" py "import json; s=[x for x in json.load(open('$RECORDS/emitter.json'))['steps'] if x['id']=='publish-again'][0]; assert s['state']=='completed' and 'tx' not in s and s.get('skipped'), s"
check "still exactly one Misc event" test "$(events_of "$EM_ADDR")" = 1

rc=0; signer em-remove remove-circuit $A --record /e2e/records/emitter.json --circuit publishMetadata || rc=$?
expect_rc "remove-circuit publishMetadata (v4)" 0 "$rc"
rc=0; signer em-remove-again remove-circuit $A --record /e2e/records/emitter.json --circuit publishMetadata || rc=$?
expect_rc "remove-circuit re-run (already completed)" 0 "$rc"
rc=0; signer em-publish-after-remove publish $A --record /e2e/records/emitter.json --circuit publishMetadata --step after-remove --force || rc=$?
expect_rc "publish after the key removal is refused before submission" 1 "$rc"
check "still exactly one Misc event after the refused publish" test "$(events_of "$EM_ADDR")" = 1

# ------------------------------------------------------------------------------------------- deploy-and-publish
say "deploy-and-publish --example toolchain-spike"
A1_META='{"domainSep":"0x1111111111111111111111111111111111111111111111111111111111111111","kind":3,"name":"Acme Token","symbol":"ACME","decimals":6,"standards":["mip-0004"]}'
rc=0; signer dap deploy-and-publish $A --example toolchain-spike --metadata "$A1_META" --record /e2e/records/dap.json || rc=$?
expect_rc "deploy-and-publish (deploy → publish → verify with the metadata)" 0 "$rc"
rc=0; signer dap-again deploy-and-publish $A --example toolchain-spike --metadata "$A1_META" --record /e2e/records/dap.json --no-verify || rc=$?
expect_rc "deploy-and-publish re-run (every step already completed)" 0 "$rc"

# ------------------------------------------------------------------------------------- OZ Ownable token (kind 1)
say "SpikeOzToken: owner deploy, mint, publish; non-owner refused"
OZ_ADAPTER="test-contracts/toolchain-spike/spike-oz-token.adapter.ts"
DS1="0x2222222222222222222222222222222222222222222222222222222222222222"
rc=0; signer oz-deploy deploy $A --adapter "$OZ_ADAPTER" --args "[\"$DS1\",\"Spike Shielded\",\"SPS\",6]" --record /e2e/records/oz.json || rc=$?
expect_rc "deploy SpikeOzToken (owner secret only in the 0600 private state)" 0 "$rc"
OZ_ADDR="$(jget "$RECORDS/oz.json" 'd["contract"]["address"]')"
rc=0; signer oz-mint call $A --record /e2e/records/oz.json --circuit mint --args "[{\"bytes\":\"0x$CPK_A\"},1000,\"0x$(printf '01%.0s' $(seq 1 32))\"]" || rc=$?
expect_rc "owner mints 1000 shielded (kind 1) to wallet A" 0 "$rc"
rc=0; signer oz-publish publish $A --record /e2e/records/oz.json --circuit publishMetadata --args '[{"$utf8":"Spike Shld"},{"$utf8":"SPSH"}]' || rc=$?
expect_rc "owner publishes kind-1 metadata" 0 "$rc"
OZ_EVENTS_BEFORE="$(events_of "$OZ_ADDR")"
cp "$RECORDS/oz.json" "$RECORDS/oz-nonowner.json"
rc=0; signer oz-nonowner publish $B --record /e2e/records/oz-nonowner.json --circuit publishMetadata --args '[{"$utf8":"Evil Token"},{"$utf8":"EVIL"}]' --step non-owner || rc=$?
expect_rc "non-owner publish refused" 1 "$rc"
check "non-owner: refused before submission (no transaction in the step)" py "import json; s=[x for x in json.load(open('$RECORDS/oz-nonowner.json'))['steps'] if x['id']=='non-owner'][0]; assert 'tx' not in s and s['state']=='pending', s"
check "non-owner: the failure is the Ownable check" grep -q "caller is not the owner" "$LOGS/oz-nonowner.err"
check "non-owner: no new event on chain" test "$(events_of "$OZ_ADDR")" = "$OZ_EVENTS_BEFORE"

# ------------------------------------------------------------------------------------- native mints (kinds 1, 2)
say "ScannerMints: unshielded and shielded mints"
SM="test-contracts/scanner-mints/managed/ScannerMints"
DS2="0x3333333333333333333333333333333333333333333333333333333333333333"
DS3="0x3434343434343434343434343434343434343434343434343434343434343434"
DS4="0x3535353535353535353535353535353535353535353535353535353535353535"
rc=0; signer sm-deploy deploy $A --contract "$SM" --record /e2e/records/sm.json || rc=$?
expect_rc "deploy ScannerMints" 0 "$rc"
SM_ADDR="$(jget "$RECORDS/sm.json" 'd["contract"]["address"]')"
rc=0; signer sm-mint-u1 call $A --record /e2e/records/sm.json --circuit mintUnshielded --args "[\"$DS2\",500]" || rc=$?
expect_rc "mint unshielded 500 of domainSep 0x33…" 0 "$rc"
rc=0; signer sm-mint-u2 call $A --record /e2e/records/sm.json --circuit mintUnshielded --args "[\"$DS3\",700]" || rc=$?
expect_rc "mint unshielded 700 of domainSep 0x34…" 0 "$rc"
rc=0; signer sm-mint-u1b call $A --record /e2e/records/sm.json --circuit mintUnshielded --args "[\"$DS2\",5]" || rc=$?
expect_rc "mint unshielded 5 more of domainSep 0x33… (same color)" 0 "$rc"
rc=0; signer sm-mint-s call $A --record /e2e/records/sm.json --circuit mintShielded --args "[\"$DS4\",900,\"0x$(printf '02%.0s' $(seq 1 32))\",{\"bytes\":\"0x$CPK_A\"}]" || rc=$?
expect_rc "mint shielded 900 of domainSep 0x35… to wallet A" 0 "$rc"
rc=0; signer sm-publish publish $A --record /e2e/records/sm.json --circuit publishMetadata --args "[\"$DS2\",2,{\"\$utf8\":\"UNSA\"}]" || rc=$?
expect_rc "publish kind-2 metadata for 0x33…" 0 "$rc"

# ------------------------------------------------------------------------------------------------- mint scanner
# The local chain starts at 0 or 1 depending on whether the indexer serves the genesis block.
FROM=0
if gql '{"query":"{ block(offset:{height:0}) { height } }"}' | grep -q '"block":null'; then FROM=1; fi
say "mint scanner from height $FROM"
rc=0; cli index-full index --network undeployed --from-height "$FROM" --state /e2e/index/full --json || rc=$?
expect_rc "index from $FROM to the tip (subscription)" 0 "$rc"
TO="$(jget "$INDEX/full/index-state.json" 'd["nextHeight"]-1')"
color() { MIP0018_DOCKER_NETWORK=none "$repo/docker/run.sh" exec "node packages/cli/test/e2e/color.ts $1 $2" 2>/dev/null | tail -1; }
C1="$(color "$DS1" "$OZ_ADDR")"; C2="$(color "$DS2" "$SM_ADDR")"; C3="$(color "$DS3" "$SM_ADDR")"; C4="$(color "$DS4" "$SM_ADDR")"
check "scanner: exactly the four minted colors, each once with the right (contract, domainSep, kinds)" py "
import json
s=json.load(open('$INDEX/full/index-state.json'))
c=s['colors']
want={'$C1':('$OZ_ADDR','${DS1#0x}','shielded',1,'1000'),'$C2':('$SM_ADDR','${DS2#0x}','unshielded',2,'505'),'$C3':('$SM_ADDR','${DS3#0x}','unshielded',1,'700'),'$C4':('$SM_ADDR','${DS4#0x}','shielded',1,'900')}
assert set(c)==set(want), (sorted(c), sorted(want))
for k,(addr,ds,kind,n,amt) in want.items():
  e=c[k]; assert e['contractAddress']==addr and e['domainSep']==ds, e
  other='unshielded' if kind=='shielded' else 'shielded'
  assert e[kind]['mints']==n and e[kind]['amount']==amt and other not in e, e
assert s['stats']['decodeErrors']==0
"
check "scanner: MIP-0018 events equal the indexer's per contract (bytes and order)" py "
import json,urllib.request
s=json.load(open('$INDEX/full/index-state.json'))
for addr in ['$EM_ADDR','$OZ_ADDR','$SM_ADDR']:
  q=json.dumps({'query':'{ contractEvents(filter:{contractAddress:\"%s\", types:[MISC]}, limit:500) { id ... on MiscContractEvent { name payload } } }' % addr}).encode()
  r=json.load(urllib.request.urlopen(urllib.request.Request('$IDX', q, {'Content-Type':'application/json'})))
  idx=[(e['name'],e['payload']) for e in sorted(r['data']['contractEvents'], key=lambda e:e['id'])]
  mine=[(e['name'],e['payload']) for e in s['events'].get(addr,[])]
  assert idx==mine and len(mine)>=1, (addr, len(idx), len(mine))
"
check "scanner: every deploy of this run seen once" py "
import json,glob
s=json.load(open('$INDEX/full/index-state.json'))
addrs=[json.load(open(f))['contract']['address'] for f in glob.glob('$RECORDS/*.json') if 'nonowner' not in f and 'spike' not in f]
for a in addrs: assert a in s['deploys'], a
"

say "mint scanner killed mid-scan and resumed"
HALF=$(( (TO - FROM + 1) / 2 ))
rc=0; EXTRA_ENV="" MIP0018_DOCKER_NETWORK="$NET" MIP0018_DOCKER_ENV="$ENV_NET -e MIP0018_TEST_SCAN_CRASH_AFTER_BLOCKS=$HALF" \
  "$repo/docker/run.sh" mip0018 -- index --network undeployed --from-height "$FROM" --to-height "$TO" --state /e2e/index/resumed --poll >"$LOGS/index-crash.out" 2>"$LOGS/index-crash.err" || rc=$?
expect_killed "index killed by the test hook after $HALF blocks" "$rc" "$LOGS/index-crash.err"
rc=0; cli index-resume index --network undeployed --from-height "$FROM" --to-height "$TO" --state /e2e/index/resumed || rc=$?
expect_rc "index resumed to $TO" 0 "$rc"
check "resumed table == uninterrupted table (colors, events, deploys)" py "
import json
a=json.load(open('$INDEX/full/index-state.json')); b=json.load(open('$INDEX/resumed/index-state.json'))
for k in ['colors','events','deploys','fromHeight','nextHeight','lastBlock']: assert a[k]==b[k], k
"

# ---------------------------------------------------------------------------------------------------------- lookup
say "lookup"
rc=0; cli lookup-k1 lookup --color "$C1" --state /e2e/index/full --network undeployed --json || rc=$?
expect_rc "lookup the OZ shielded color (live metadata)" 0 "$rc"
check "lookup kind 1 → (OZ contract, 0x22…, 1) with name/symbol/decimals" py "
import json; d=json.load(open('$LOGS/lookup-k1.out')); r=d['resolved']; assert len(r)==1 and r[0]['kind']==1 and r[0]['contractAddress']=='$OZ_ADDR'
m=r[0]['metadata']['common']; assert m['name']=='Spike Shld' and m['symbol']=='SPSH' and str(m['decimals'])=='6', m
assert r[0]['metadata']['color']
"
rc=0; cli lookup-k2 lookup --color "$C2" --kind 2 --state /e2e/index/full --json || rc=$?
expect_rc "lookup the 0x33… unshielded color (from the scanned events)" 0 "$rc"
check "lookup kind 2 → symbol UNSA, decimals 2, color = the minted color" py "
import json; d=json.load(open('$LOGS/lookup-k2.out')); r=d['resolved'][0]; m=r['metadata']
assert r['kind']==2 and m['common']['symbol']=='UNSA' and str(m['common']['decimals'])=='2'
"
rc=0; cli lookup-nometa lookup --color "$C3" --state /e2e/index/full || rc=$?
expect_rc "lookup a minted color without metadata" 0 "$rc"
check "lookup without metadata says so" grep -q "no MIP-0018 metadata published" "$LOGS/lookup-nometa.out"
rc=0; cli lookup-unknown lookup --color "$(printf 'ab%.0s' $(seq 1 32))" --state /e2e/index/full || rc=$?
expect_rc "lookup an unknown color" 3 "$rc"
check "unknown color reports the scanned range" grep -q "not minted in the scanned range \[$FROM, $TO\]" "$LOGS/lookup-unknown.out"
rc=0; cli lookup-k3 lookup --color "$C1" --kind 3 --state /e2e/index/full || rc=$?
expect_rc "lookup --kind 3 (no color for ledger tokens)" 2 "$rc"

# ------------------------------------------------------------------------------------------------- identity guards
say "identity guards"
rc=0; signer guard-genesis deploy $A --contract "$EM" --record /e2e/records/guard.json --genesis "0x$(printf 'de%.0s' $(seq 1 32))" || rc=$?
expect_rc "wrong genesis aborts before any wallet or submission" 1 "$rc"
check "wrong-genesis run created no record" test ! -e "$RECORDS/guard.json"
check "wrong-genesis error names the chain mismatch" grep -q "wrong chain" "$LOGS/guard-genesis.err"
rc=0; cli guard-public verify --network undeployed --indexer https://indexer.stagenet.shielded.tools/api/v4/graphql --rpc http://node:9944 --contract "$EM_ADDR" --tx "$PUB_TX" || rc=$?
expect_rc "undeployed profile refuses a Stagenet URL (usage)" 2 "$rc"
rc=0; signer guard-usage publish $B --record /e2e/records/emitter.json --bogus || rc=$?
expect_rc "unknown option rejected before anything runs (usage)" 2 "$rc"

# --------------------------------------------------------------------------------------------------- wallet cache
say "wallet sync cache"
rc=0; signer cache-1 wallet status $B --wallet-cache /run/mip0018/state/b.wallet-cache --json || rc=$?
expect_rc "wallet status writes the 0600 sync cache" 0 "$rc"
rc=0; signer cache-2 wallet status $B --wallet-cache /run/mip0018/state/b.wallet-cache --json || rc=$?
expect_rc "wallet status again" 0 "$rc"
check "second run restored the wallet from the cache" grep -q "restored from its 0600 sync cache" "$LOGS/cache-2.err"
check "cache file is mode 0600 and restored addresses are equal" py "
import json,os,stat
assert stat.S_IMODE(os.stat('$STATE/b.wallet-cache').st_mode)==0o600
a=json.load(open('$LOGS/cache-1.out')); b=json.load(open('$LOGS/cache-2.out'))
assert all(a[k]==b[k] for k in ['unshieldedAddress','shieldedAddress','dustAddress','coinPublicKey','night','nightUtxos'])
"

# ------------------------------------------------------------------------------------------------------- secrets
say "secret scan"
check "no secret value in any log, record or index state" py "
import json,glob,os,re
secrets=set()
secrets.add(open('$SECRETS/b.seed').read().strip().lower())
def walk(v):
  if isinstance(v,dict):
    if set(v)=={'\$bytes'}: secrets.add(v['\$bytes'].lower()); return
    for x in v.values(): walk(x)
  elif isinstance(v,list):
    for x in v: walk(x)
  elif isinstance(v,str) and len(v)>=32: secrets.add(v.lower())
for f in glob.glob('$STATE/*.json'):  # private-state files (the wallet cache is checked for its mode only)
  d=json.load(open(f)); walk(d.get('signingKeys',{})); walk(d.get('states',{}))
secrets={s for s in secrets if len(s)>=32}
assert secrets, 'no secret values collected'
hits=[]
for root in ['$LOGS','$RECORDS','$INDEX']:
  for dp,_,fs in os.walk(root):
    for fn in fs:
      p=os.path.join(dp,fn); t=open(p,errors='ignore').read().lower()
      for s in secrets:
        if s in t: hits.append((p,s[:8]))
assert not hits, hits
print('secret values checked:', len(secrets))
"
check "private-state file is mode 0600" py "import os,stat,glob; fs=glob.glob('$STATE/*.json'); assert fs and all(stat.S_IMODE(os.stat(f).st_mode)==0o600 for f in fs), [oct(os.stat(f).st_mode) for f in fs]"

say "done: $failures failure(s)"
exit "$failures"
