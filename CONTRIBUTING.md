# Contributing

## Docker-only workflow

Nothing is installed on the host: every build, compile and test runs in the pinned toolchain image (`docker/Dockerfile`: Node 24 + the official Compact 0.35.0 release, SHA-256 checked).

```sh
docker/run.sh ci                     # npm ci from package-lock.json
docker/run.sh lint typecheck test    # several npm scripts in order
docker/run.sh compile:spike -- --skip-zk   # arguments after `--` go to the last script
docker/run.sh exec <command>         # any command in the image
```

- The repository is bind-mounted at `/work`; the container runs as your uid/gid. `node_modules`, the npm cache and ZK parameters live in named volumes (`<prefix>-node-modules`, …). `MIP0018_DOCKER_PREFIX` sets the prefix of every container, network and volume a script creates; remove only what you created, by exact name or by the label `org.midnight-experiments.mip-0018.prefix=<prefix>`.
- Chain tests use the local stack: `docker/local-stack/up.sh` (random free loopback ports ≥ 10000, written to `docker/local-stack/ports.env`), `fund.sh` for a funded test wallet, `down.sh` to remove it. Its state and logs are never committed.
- Signing runs use `docker/signer.sh` (see [`SECURITY.md`](SECURITY.md)).
- Versions are pinned in [`toolchain.json`](toolchain.json); `docker/run.sh check:pins` keeps the Dockerfile, the compose file and the manifests consistent with it. Only official binaries: Compact releases from `midnightntwrk/compact`, `midnightntwrk/*` images by digest, npm packages from the official scopes.
- Compile every Compact file with Compact 0.35.0 and `--feature-zkir-v3`.

Before opening or updating a pull request: `docker/run.sh ci lint typecheck test check:pins check:secrets check:mip-pin check:conformance-matrix check:md-links`.

## The MIP is the authority

Every byte and rule comes from the pinned MIP-0018 text (`toolchain.json` → `mip`). If the code needs a decision the MIP does not make, or the MIP should change, do not invent the rule silently:

## Commits

Plain, descriptive commit messages. Do not commit generated Docker state, logs, wallet files or anything secret.
