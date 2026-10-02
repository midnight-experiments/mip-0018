#!/usr/bin/env bash
# S0 spike, step 3: deploy SpikeEmitter on Stagenet, call publishMetadata()
# once, confirm the event on the public indexer, then remove the circuit's
# verifier key (create and destroy). Spends DUST from the signer wallet.
#
#   MIP0018_SECRET_DIR=<dir with the mnemonic file> \
#   MIP0018_STATE_DIR=<private dir for the maintenance key> \
#   MIP0018_MNEMONIC_NAME=<mnemonic file name inside MIP0018_SECRET_DIR> \
#   MIP0018_EXPECTED_ADDRESS=<the signer's mn_addr_stagenet1... address> \
#     test-contracts/toolchain-spike/scripts/stagenet.sh
#
# Starts the two official proof servers (contract circuits: 9.0.0-rc.8; DUST
# spends: 9.0.0-rc.6 — see Q21) on a private Docker network with no published
# ports, runs `npm run spike:stagenet` in the signer container (docker/signer.sh)
# and removes the provers and the network afterwards. bash 3.2 compatible.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd -P)"
repo="$(cd "$here/../../.." && pwd -P)"
# shellcheck source=docker/common.sh
. "$repo/docker/common.sh"

: "${MIP0018_SECRET_DIR:?}" "${MIP0018_STATE_DIR:?}" "${MIP0018_MNEMONIC_NAME:?}" "${MIP0018_EXPECTED_ADDRESS:?}"

PROVER_IMAGE=midnightntwrk/proof-server:9.0.0-rc.8@sha256:2666c7bd7b4517f8ad135565387f98d14347a9ac715c6c466d4a8a852b545ecf
WALLET_PROVER_IMAGE=midnightntwrk/proof-server:9.0.0-rc.6@sha256:38a819eacde273f725551fdf90ca7c31ebf3c0ff145f3ed58ee35f92fb7ce95b

net="${MIP0018_DOCKER_PREFIX}-stagenet-$(mip0018_rand)"
prover="${net}-prover"
wallet_prover="${net}-wallet-prover"

cleanup() {
  docker rm -f "$prover" "$wallet_prover" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
  echo "removed $prover, $wallet_prover and $net" >&2
}
trap cleanup EXIT

docker network create --label "$MIP0018_LABEL" "$net" >/dev/null
docker run -d --name "$prover" --label "$MIP0018_LABEL" --network "$net" "$PROVER_IMAGE" >/dev/null
docker run -d --name "$wallet_prover" --label "$MIP0018_LABEL" --network "$net" "$WALLET_PROVER_IMAGE" >/dev/null
echo "proof servers $prover (contract) and $wallet_prover (DUST) on $net" >&2

mip0018_ensure_image
for p in "$prover" "$wallet_prover"; do
  ok=""
  for i in $(seq 1 60); do
    if docker run --rm --name "${net}-probe-$(mip0018_rand)" --label "$MIP0018_LABEL" --network "$net" "$MIP0018_IMAGE" \
      curl -fsS -m 5 "http://$p:6300/health" >/dev/null 2>&1; then ok=1; break; fi
    sleep 2
  done
  [ -n "$ok" ] || { echo "$p did not become healthy" >&2; exit 1; }
done

MIP0018_DOCKER_NETWORK="$net" \
MIP0018_DOCKER_ENV="-e MIP0018_PROOF_SERVER_URL=http://$prover:6300 -e MIP0018_WALLET_PROOF_SERVER_URL=http://$wallet_prover:6300 -e MIP0018_MNEMONIC_FILE=/run/mip0018/secrets/$MIP0018_MNEMONIC_NAME -e MIP0018_EXPECTED_ADDRESS=$MIP0018_EXPECTED_ADDRESS" \
  "$repo/docker/signer.sh" spike:stagenet
