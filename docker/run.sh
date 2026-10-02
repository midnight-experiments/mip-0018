#!/usr/bin/env bash
# Run npm scripts (or a command) inside the pinned toolchain image.
#
#   docker/run.sh ci                         # npm ci (one retry on a network timeout)
#   docker/run.sh lint typecheck test        # several npm scripts, in order
#   docker/run.sh compile:spike -- --skip-zk # arguments after `--` go to the last script
#   docker/run.sh exec <command> [args...]   # any command in the image
#
# The repository is bind-mounted at /work and the container runs as the
# caller's uid/gid, so files it writes belong to the caller. node_modules, the
# npm cache and the ZK public parameters live in named volumes. No ports are
# published and nothing secret is mounted (signing runs use docker/signer.sh).
#
# Environment:
#   MIP0018_DOCKER_PREFIX   resource-name prefix (default: mip0018-<hash of the checkout path>)
#   MIP0018_IMAGE           use this image instead of building docker/Dockerfile
#   MIP0018_DOCKER_NETWORK  network to join (default: bridge), e.g. the local stack's network
#   MIP0018_DOCKER_ENV      extra "-e NAME=value" style arguments, space separated (no secrets)
#
# bash 3.2 compatible (macOS).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd -P)"
repo="$(cd "$here/.." && pwd -P)"
# shellcheck source=docker/common.sh
. "$here/common.sh"

if [ "$#" -eq 0 ]; then
  sed -n '2,20p' "$0" >&2
  exit 2
fi

mip0018_ensure_image
mip0018_ensure_volumes

scripts=""
extra=""
mode="npm"
if [ "$1" = "exec" ]; then
  mode="exec"
  shift
else
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--" ]; then
      shift
      # Quote each argument so JSON and spaces survive the inner `bash -c` (bash 3.2: printf %q).
      extra="$(printf '%q ' "$@")"
      break
    fi
    scripts="$scripts $1"
    shift
  done
fi

if [ "$mode" = "exec" ]; then
  cmd="$*"
else
  cmd="set -e"
  last=""
  for s in $scripts; do last="$s"; done
  for s in $scripts; do
    if [ "$s" = "ci" ]; then
      cmd="$cmd; npm ci || { echo 'npm ci failed; retrying once' >&2; npm ci; }"
    elif [ "$s" = "$last" ] && [ -n "$extra" ]; then
      cmd="$cmd; npm run -s $s -- $extra"
    else
      cmd="$cmd; npm run -s $s"
    fi
  done
fi

# Pre-create the mount point so Docker does not create it root-owned.
mkdir -p "$repo/node_modules"

name="${MIP0018_DOCKER_PREFIX}-run-$(mip0018_rand)"
# shellcheck disable=SC2086
exec docker run --rm \
  --name "$name" \
  --label "$MIP0018_LABEL" \
  --network "${MIP0018_DOCKER_NETWORK:-bridge}" \
  --user "$(id -u):$(id -g)" \
  -e HOME=/tmp/home \
  -e NPM_CONFIG_CACHE=/cache/npm \
  -e MIDNIGHT_PP=/cache/zk-params \
  -e CI="${CI:-}" \
  ${MIP0018_DOCKER_ENV:-} \
  -v "$repo:/work" \
  -v "${MIP0018_DOCKER_PREFIX}-node-modules:/work/node_modules" \
  -v "${MIP0018_DOCKER_PREFIX}-npm-cache:/cache/npm" \
  -v "${MIP0018_DOCKER_PREFIX}-zk-params:/cache/zk-params" \
  -w /work \
  "$MIP0018_IMAGE" \
  bash -c "mkdir -p /tmp/home && $cmd"
