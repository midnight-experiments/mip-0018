#!/usr/bin/env bash
# Toolchain spike, step 3: deploy SpikeEmitter on Stagenet, call publishMetadata()
# once, confirm the event on the public indexer, then remove the circuit's
# verifier key (create and destroy). Spends DUST from the signer wallet.
#
#   MIP0018_SECRET_DIR=<dir with the mnemonic file> \
#   MIP0018_STATE_DIR=<private dir for the maintenance key> \
#   MIP0018_MNEMONIC_NAME=<mnemonic file name inside MIP0018_SECRET_DIR> \
#   MIP0018_EXPECTED_ADDRESS=<the signer's mn_addr_stagenet1... address> \
#     test-contracts/toolchain-spike/scripts/stagenet.sh
#
# Starts the official proof server (contract circuits and DUST spends) on a
# private Docker network with no published ports, runs `npm run spike:stagenet`
# in the signer container (docker/signer.sh) and removes the prover and the
# network afterwards. bash 3.2 compatible.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd -P)"
repo="$(cd "$here/../../.." && pwd -P)"
# shellcheck source=docker/common.sh
. "$repo/docker/common.sh"

: "${MIP0018_SECRET_DIR:?}" "${MIP0018_STATE_DIR:?}" "${MIP0018_MNEMONIC_NAME:?}" "${MIP0018_EXPECTED_ADDRESS:?}"

PROVER_IMAGE=midnightntwrk/proof-server:9.0.1@sha256:90e36a14f92c2004127f0ed1cfd6ee89d770cf1f6e9cd7f02026ffd4ecb42f37

net="${MIP0018_DOCKER_PREFIX}-stagenet-$(mip0018_rand)"
prover="${net}-prover"

cleanup() {
  docker rm -f "$prover" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
  echo "removed $prover and $net" >&2
}
trap cleanup EXIT

docker network create --label "$MIP0018_LABEL" "$net" >/dev/null
docker run -d --name "$prover" --label "$MIP0018_LABEL" --network "$net" "$PROVER_IMAGE" >/dev/null
echo "proof server $prover on $net" >&2

mip0018_ensure_image
for p in "$prover"; do
  ok=""
  for i in $(seq 1 60); do
    if docker run --rm --name "${net}-probe-$(mip0018_rand)" --label "$MIP0018_LABEL" --network "$net" "$MIP0018_IMAGE" \
      curl -fsS -m 5 "http://$p:6300/health" >/dev/null 2>&1; then ok=1; break; fi
    sleep 2
  done
  [ -n "$ok" ] || { echo "$p did not become healthy" >&2; exit 1; }
done

MIP0018_DOCKER_NETWORK="$net" \
MIP0018_DOCKER_ENV="-e MIP0018_PROOF_SERVER_URL=http://$prover:6300 -e MIP0018_MNEMONIC_FILE=/run/mip0018/secrets/$MIP0018_MNEMONIC_NAME -e MIP0018_EXPECTED_ADDRESS=$MIP0018_EXPECTED_ADDRESS" \
  "$repo/docker/signer.sh" spike:stagenet
