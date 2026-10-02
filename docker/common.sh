# Shared helpers for docker/*.sh (sourced, not executed). bash 3.2 compatible.
#
# Every Docker resource these scripts create is named "${MIP0018_DOCKER_PREFIX}-<purpose>"
# and labelled "${MIP0018_LABEL}", so teardown can remove exactly what was created
# and nothing else.

mip0018_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi
}

mip0018_rand() {
  od -An -N4 -tx1 /dev/urandom | tr -d ' \n'
}

if [ -z "${MIP0018_DOCKER_PREFIX:-}" ]; then
  MIP0018_DOCKER_PREFIX="mip0018-$(printf '%s' "$repo" | mip0018_sha256 | cut -c1-8)"
fi
case "$MIP0018_DOCKER_PREFIX" in
  *[!a-z0-9_.-]*) echo "MIP0018_DOCKER_PREFIX must match [a-z0-9_.-]+" >&2; exit 2 ;;
esac
MIP0018_LABEL="org.midnight-experiments.mip-0018.prefix=${MIP0018_DOCKER_PREFIX}"

mip0018_ensure_image() {
  if [ -n "${MIP0018_IMAGE:-}" ]; then
    return 0
  fi
  local digest
  digest="$(mip0018_sha256 <"$repo/docker/Dockerfile" | cut -c1-12)"
  MIP0018_IMAGE="${MIP0018_DOCKER_PREFIX}-toolchain:${digest}"
  if ! docker image inspect "$MIP0018_IMAGE" >/dev/null 2>&1; then
    echo "building $MIP0018_IMAGE from docker/Dockerfile" >&2
    docker build --label "$MIP0018_LABEL" -f "$repo/docker/Dockerfile" -t "$MIP0018_IMAGE" "$repo/docker" >&2
  fi
}

mip0018_ensure_volumes() {
  local v created
  created=""
  for v in node-modules npm-cache zk-params; do
    if ! docker volume inspect "${MIP0018_DOCKER_PREFIX}-$v" >/dev/null 2>&1; then
      docker volume create --label "$MIP0018_LABEL" "${MIP0018_DOCKER_PREFIX}-$v" >/dev/null
      created="$created ${MIP0018_DOCKER_PREFIX}-$v"
    fi
  done
  if [ -n "$created" ]; then
    # New volumes are root-owned; hand them to the caller's uid once.
    local args="" vol
    for vol in $created; do args="$args -v $vol:/v/$vol"; done
    # shellcheck disable=SC2086
    docker run --rm --name "${MIP0018_DOCKER_PREFIX}-chown-$(mip0018_rand)" --label "$MIP0018_LABEL" \
      --network none $args "$MIP0018_IMAGE" chown -R "$(id -u):$(id -g)" /v >/dev/null
  fi
}
