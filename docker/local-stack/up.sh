#!/usr/bin/env bash
# Start the local undeployed Midnight chain (node + indexer + proof server) from
# official midnightntwrk images pinned by digest.
#
#   docker/local-stack/up.sh        # start, wait until usable, write docker/local-stack/ports.env
#   docker/local-stack/down.sh      # stop and remove exactly this stack
#
# Host ports are random free loopback ports >= 10000. Containers on the stack's
# network reach the services as node:9944, indexer:8088 and proof-server:6300
# (see ports.env). Uses the same MIP0018_DOCKER_PREFIX as docker/run.sh.
# bash 3.2 compatible.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd -P)"
repo="$(cd "$here/../.." && pwd -P)"
# shellcheck source=docker/common.sh
. "$repo/docker/common.sh"

state="$here/ports.env"
if [ -f "$state" ]; then
  echo "a stack is already recorded in $state; run docker/local-stack/down.sh first" >&2
  exit 1
fi

port_in_use() {
  local p="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$p\$" && return 0
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1 && return 0
  fi
  docker ps --format '{{.Ports}}' | grep -Eq "[:]$p->" && return 0
  return 1
}

pick_port() {
  local i p n
  for i in $(seq 1 100); do
    n=$(od -An -N2 -tu2 /dev/urandom | tr -d ' ')
    p=$(( 10000 + n % 50000 ))
    case " ${picked:-} " in *" $p "*) continue ;; esac
    if ! port_in_use "$p"; then
      picked="${picked:-} $p"
      echo "$p"
      return 0
    fi
  done
  echo "no free port found" >&2
  return 1
}

picked=""
MIP0018_NODE_PORT=$(pick_port); picked="$picked $MIP0018_NODE_PORT"
MIP0018_INDEXER_PORT=$(pick_port); picked="$picked $MIP0018_INDEXER_PORT"
MIP0018_PROOF_PORT=$(pick_port); picked="$picked $MIP0018_PROOF_PORT"
MIP0018_WALLET_PROOF_PORT=$(pick_port); picked="$picked $MIP0018_WALLET_PROOF_PORT"
MIP0018_STACK_PROJECT="${MIP0018_DOCKER_PREFIX}-stack-$(mip0018_rand)"
export MIP0018_DOCKER_PREFIX MIP0018_STACK_PROJECT MIP0018_NODE_PORT MIP0018_INDEXER_PORT MIP0018_PROOF_PORT MIP0018_WALLET_PROOF_PORT

umask 077
cat >"$state" <<EOF
# Written by docker/local-stack/up.sh; removed by down.sh. Not committed.
MIP0018_DOCKER_PREFIX=$MIP0018_DOCKER_PREFIX
MIP0018_STACK_PROJECT=$MIP0018_STACK_PROJECT
MIP0018_STACK_NETWORK=${MIP0018_STACK_PROJECT}_default
MIP0018_NODE_PORT=$MIP0018_NODE_PORT
MIP0018_INDEXER_PORT=$MIP0018_INDEXER_PORT
MIP0018_PROOF_PORT=$MIP0018_PROOF_PORT
MIP0018_WALLET_PROOF_PORT=$MIP0018_WALLET_PROOF_PORT
# From the host
MIP0018_NODE_URL=http://127.0.0.1:$MIP0018_NODE_PORT
MIP0018_INDEXER_URL=http://127.0.0.1:$MIP0018_INDEXER_PORT/api/v4/graphql
MIP0018_PROOF_SERVER_URL=http://127.0.0.1:$MIP0018_PROOF_PORT
MIP0018_WALLET_PROOF_SERVER_URL=http://127.0.0.1:$MIP0018_WALLET_PROOF_PORT
# From a container on the stack network (docker/run.sh with MIP0018_DOCKER_NETWORK)
MIP0018_NODE_URL_IN_NETWORK=http://node:9944
MIP0018_INDEXER_URL_IN_NETWORK=http://indexer:8088/api/v4/graphql
MIP0018_PROOF_SERVER_URL_IN_NETWORK=http://proof-server:6300
MIP0018_WALLET_PROOF_SERVER_URL_IN_NETWORK=http://wallet-proof-server:6300
EOF

echo "starting $MIP0018_STACK_PROJECT (node :$MIP0018_NODE_PORT, indexer :$MIP0018_INDEXER_PORT, proof servers :$MIP0018_PROOF_PORT contract / :$MIP0018_WALLET_PROOF_PORT wallet)" >&2
if ! docker compose -f "$here/compose.yml" up -d --wait --wait-timeout 300 >&2; then
  echo "the stack did not become healthy; inspect with: docker compose -p $MIP0018_STACK_PROJECT logs" >&2
  exit 1
fi

rpc() {
  curl -fsS -m 10 -H 'Content-Type: application/json' \
    -d "{\"id\":1,\"jsonrpc\":\"2.0\",\"method\":\"$1\",\"params\":${2:-[]}}" "http://127.0.0.1:$MIP0018_NODE_PORT"
}

# Block production: the best block number must advance.
first=""
for i in $(seq 1 60); do
  n=$(rpc chain_getHeader | sed -n 's/.*"number":"\(0x[0-9a-f]*\)".*/\1/p')
  if [ -n "$n" ]; then
    n=$((n))
    if [ -z "$first" ]; then first="$n"; elif [ "$n" -gt "$first" ]; then break; fi
  fi
  sleep 2
done
if [ -z "$first" ] || [ "$n" -le "$first" ]; then
  echo "the node is not producing blocks" >&2
  exit 1
fi
echo "node producing blocks (best #$n)" >&2

# Indexer: GraphQL answers with an indexed block.
for i in $(seq 1 90); do
  h=$(curl -fsS -m 10 -H 'Content-Type: application/json' -d '{"query":"{ block { height } }"}' \
    "http://127.0.0.1:$MIP0018_INDEXER_PORT/api/v4/graphql" 2>/dev/null | sed -n 's/.*"height":\([0-9]*\).*/\1/p' || true)
  if [ -n "$h" ] && [ "$h" -ge 1 ]; then break; fi
  sleep 2
done
if [ -z "${h:-}" ]; then
  echo "the indexer did not answer" >&2
  exit 1
fi
echo "indexer at block $h" >&2

# Proof servers: /health.
for port in "$MIP0018_PROOF_PORT" "$MIP0018_WALLET_PROOF_PORT"; do
  ok=""
  for i in $(seq 1 60); do
    if curl -fsS -m 5 "http://127.0.0.1:$port/health" >/dev/null 2>&1; then ok=1; break; fi
    sleep 2
  done
  if [ -z "$ok" ]; then
    echo "the proof server on :$port did not answer /health" >&2
    exit 1
  fi
  echo "proof server :$port healthy: $(curl -fsS -m 5 "http://127.0.0.1:$port/version" 2>/dev/null || echo '?')" >&2
done
echo "ready; settings in $state" >&2
