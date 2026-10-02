#!/usr/bin/env bash
# Fund a local test wallet from the dev chain's genesis wallet and register its
# NIGHT for DUST generation (local stack only; the genesis seed is public).
#
#   docker/local-stack/fund.sh <seed-file> [night]
#
# <seed-file> holds the test wallet's hex seed (created with a random seed if it
# does not exist; mode 0600; keep it outside the repository). Prints the wallet's
# public addresses and balances. bash 3.2 compatible.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd -P)"
repo="$(cd "$here/../.." && pwd -P)"
if [ "$#" -lt 1 ]; then sed -n '2,10p' "$0" >&2; exit 2; fi
seed="$1"
night="${2:-1000}"
[ -f "$here/ports.env" ] || { echo "no local stack is running (docker/local-stack/up.sh)" >&2; exit 1; }
# shellcheck disable=SC1091
. "$here/ports.env"

dir="$(cd "$(dirname "$seed")" && pwd -P)"
file="$(basename "$seed")"
if [ ! -f "$dir/$file" ]; then
  (umask 077; od -An -N32 -tx1 /dev/urandom | tr -d ' \n' >"$dir/$file")
  echo "created a new local test seed in $dir/$file" >&2
fi

MIP0018_DOCKER_PREFIX="$MIP0018_DOCKER_PREFIX" \
MIP0018_DOCKER_NETWORK="$MIP0018_STACK_NETWORK" \
MIP0018_SECRET_DIR="$dir" \
MIP0018_STATE_DIR="$dir" \
MIP0018_DOCKER_ENV="-e MIP0018_SEED_FILE=/run/mip0018/secrets/$file -e MIP0018_FUND_NIGHT=$night" \
  "$repo/docker/signer.sh" local:fund
