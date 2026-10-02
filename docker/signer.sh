#!/usr/bin/env bash
# Run an npm script in the pinned toolchain image as a SIGNER: the only kind of
# container that ever sees wallet secrets.
#
#   MIP0018_SECRET_DIR=<dir> MIP0018_STATE_DIR=<dir> docker/signer.sh <npm-script> [-- args]
#
#   MIP0018_SECRET_DIR   host directory holding the secret file(s) (mode 0700, files 0600,
#                        outside every Git tree); mounted READ-ONLY at /run/mip0018/secrets
#   MIP0018_STATE_DIR    host directory for private state the run must keep (maintenance
#                        signing keys, wallet caches); mounted read-write at /run/mip0018/state
#   MIP0018_DOCKER_NETWORK, MIP0018_DOCKER_ENV, MIP0018_IMAGE, MIP0018_DOCKER_PREFIX: as docker/run.sh
#
# Inside the container: MIP0018_SECRET_DIR=/run/mip0018/secrets and
# MIP0018_STATE_DIR=/run/mip0018/state. Scripts read secrets from file paths and
# never print them. No ports are published. bash 3.2 compatible.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd -P)"
repo="$(cd "$here/.." && pwd -P)"
# shellcheck source=docker/common.sh
. "$here/common.sh"

if [ "$#" -eq 0 ]; then
  sed -n '2,18p' "$0" >&2
  exit 2
fi
: "${MIP0018_SECRET_DIR:?set MIP0018_SECRET_DIR to the directory holding the secret file}"
: "${MIP0018_STATE_DIR:?set MIP0018_STATE_DIR to a private directory outside the repository}"

for d in "$MIP0018_SECRET_DIR" "$MIP0018_STATE_DIR"; do
  [ -d "$d" ] || { echo "$d is not a directory" >&2; exit 2; }
  case "$(cd "$d" && pwd -P)/" in
    "$repo"/*) echo "$d is inside the repository; secrets and private state must live outside it" >&2; exit 2 ;;
  esac
  if git -C "$d" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "$d is inside a Git working tree; refusing" >&2
    exit 2
  fi
done

mip0018_ensure_image
mip0018_ensure_volumes
mkdir -p "$repo/node_modules"

script="$1"
shift
extra=""
if [ "${1:-}" = "--" ]; then shift; extra="$*"; fi

name="${MIP0018_DOCKER_PREFIX}-signer-$(mip0018_rand)"
# shellcheck disable=SC2086
exec docker run --rm \
  --name "$name" \
  --label "$MIP0018_LABEL" \
  --network "${MIP0018_DOCKER_NETWORK:-bridge}" \
  --user "$(id -u):$(id -g)" \
  -e HOME=/tmp/home \
  -e NPM_CONFIG_CACHE=/cache/npm \
  -e MIDNIGHT_PP=/cache/zk-params \
  -e MIP0018_SECRET_DIR=/run/mip0018/secrets \
  -e MIP0018_STATE_DIR=/run/mip0018/state \
  ${MIP0018_DOCKER_ENV:-} \
  -v "$repo:/work" \
  -v "${MIP0018_DOCKER_PREFIX}-node-modules:/work/node_modules" \
  -v "${MIP0018_DOCKER_PREFIX}-npm-cache:/cache/npm" \
  -v "${MIP0018_DOCKER_PREFIX}-zk-params:/cache/zk-params" \
  -v "$MIP0018_SECRET_DIR:/run/mip0018/secrets:ro" \
  -v "$MIP0018_STATE_DIR:/run/mip0018/state" \
  -w /work \
  "$MIP0018_IMAGE" \
  bash -c "mkdir -p /tmp/home && npm run -s $script -- $extra"
