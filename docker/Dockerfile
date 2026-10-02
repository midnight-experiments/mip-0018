# syntax=docker/dockerfile:1
#
# Pinned build/test toolchain for the MIP-0018 reference repository.
#
#   * Node 24 (official `node` image, pinned by digest)
#   * Compact toolchain 0.35.0 (language 0.27.0, runtime 0.20.0) from the
#     official release `compactc-v0.35.0`, SHA-256 checked
#   * the official `compact` launcher (devtool 0.5.3), SHA-256 checked,
#     with 0.35.0 installed as its default version
#
# Every pin here must equal `toolchain.json` (`npm run check:pins`).
# No secrets are ever copied into this image. `docker/run.sh` runs it as the
# caller's uid/gid with the repository bind-mounted at /work.

ARG NODE_IMAGE=node:24-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4
FROM ${NODE_IMAGE}

ARG COMPACT_VERSION=0.35.0
ARG COMPACT_SHA256_X86_64=70f22fb8209cc5a8504b2b3d91796cfdab2d71d88807ceef12fab87fed03bae2
ARG COMPACT_SHA256_AARCH64=3f74ec6fc98ccca7365c5c915f6015d8893db4527faafe04a90bc36effc40a3a
ARG COMPACT_DEVTOOL_VERSION=0.5.3
ARG COMPACT_DEVTOOL_SHA256_X86_64=dfaaeccefe0d77095293208171bcefc48529b8d094dada3670b0e0684932d605
ARG COMPACT_DEVTOOL_SHA256_AARCH64=8f5a54a15727eb3c93fcf0567ed1a49478682c23e0dd59a215fa6a3dadfc41d3
ARG COMPACT_RELEASES=https://github.com/midnightntwrk/compact/releases/download

ENV COMPACT_DIRECTORY=/opt/compact

RUN set -eu; \
    arch="$(uname -m)"; \
    case "$arch" in \
      x86_64)  zip_sha="$COMPACT_SHA256_X86_64";  tool_sha="$COMPACT_DEVTOOL_SHA256_X86_64" ;; \
      aarch64) zip_sha="$COMPACT_SHA256_AARCH64"; tool_sha="$COMPACT_DEVTOOL_SHA256_AARCH64" ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    triple="${arch}-unknown-linux-musl"; \
    tmp="$(mktemp -d)"; \
    curl -fsSL --retry 3 -o "$tmp/compactc.zip" \
      "$COMPACT_RELEASES/compactc-v${COMPACT_VERSION}/compactc_v${COMPACT_VERSION}_${triple}.zip"; \
    echo "${zip_sha}  $tmp/compactc.zip" | sha256sum -c -; \
    curl -fsSL --retry 3 -o "$tmp/compact.tar.xz" \
      "$COMPACT_RELEASES/compact-v${COMPACT_DEVTOOL_VERSION}/compact-${triple}.tar.xz"; \
    echo "${tool_sha}  $tmp/compact.tar.xz" | sha256sum -c -; \
    dir="$COMPACT_DIRECTORY/versions/${COMPACT_VERSION}/${triple}"; \
    mkdir -p "$dir" "$COMPACT_DIRECTORY/bin"; \
    unzip -q "$tmp/compactc.zip" -d "$dir"; \
    tar -xJf "$tmp/compact.tar.xz" -C "$tmp"; \
    install -m 0755 "$tmp/compact-${triple}/compact" /usr/local/bin/compact; \
    for f in compactc fixup-compact format-compact; do ln -s "$dir/$f" "$COMPACT_DIRECTORY/bin/$f"; done; \
    ln -s "$dir" "$COMPACT_DIRECTORY/current"; \
    chmod -R a+rX "$COMPACT_DIRECTORY"; \
    rm -rf "$tmp"; \
    compact compile --version; \
    compact compile --language-version; \
    compact compile --runtime-version

ENV PATH=/opt/compact/current:$PATH \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

LABEL org.opencontainers.image.title="mip-0018 toolchain" \
      org.opencontainers.image.description="Node 24 + official Compact 0.35.0 (zkir v3 capable) for midnight-experiments/mip-0018" \
      org.opencontainers.image.licenses="Apache-2.0"

WORKDIR /work
