# MIP-0018 reference implementation

Reference implementation of **MIP-0018: On-chain token metadata** for Midnight: test vectors, a Compact module that emits the metadata event, OpenZeppelin-based examples, deploy / publish / verify / list / index scripts, and real cases on Stagenet.

> **Status: work in progress** (one draft PR, phases S0–S6). Paths marked *planned* below land in later phases.

## The MIP this repository implements

| | |
|---|---|
| Proposal | [midnightntwrk/midnight-improvement-proposals PR #340](https://github.com/midnightntwrk/midnight-improvement-proposals/pull/340) — "Update MIP-0018 with community feedback" (open; the link moves to the merged file when #340 merges) |
| Pinned text | [`b147c627e1bb15b5d15cc73cf30c2a36afd34dbb` `mips/mip-0018-on-chain-token-metadata.md`](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/b147c627e1bb15b5d15cc73cf30c2a36afd34dbb/mips/mip-0018-on-chain-token-metadata.md) |
| SHA-256 of the pinned text | `9ffba7e6a3123cd6683e5a779ac3b73c8a31a9724367cd98ee120be78720d842` (`docker/run.sh check:mip-pin`) |
| Authority | The pinned text decides every byte and rule. What this repository found that should be defined or changed upstream is in [`MIP-PROPOSAL-NOTES.md`](MIP-PROPOSAL-NOTES.md). |

## Toolchain

MIP-0018 needs MIP-0002 `Misc` events, so it **requires Compact 0.34.0 or later** (language 0.26.0, runtime 0.19.0). This repository is **built and tested with Compact 0.35.0** (language 0.27.0, runtime 0.20.0) **and ZKIR v3** (`--feature-zkir-v3`), pinned with every other version in [`toolchain.json`](toolchain.json). Only official binaries are used: the Compact release from `midnightntwrk/compact`, `midnightntwrk/*` Docker images pinned by digest, and packages from the `@midnight-ntwrk`, `@midnightntwrk` and `@openzeppelin` npm scopes.

| Piece | Version |
|---|---|
| Compact | 0.35.0 (`debb05f9`), ZKIR v3 = `zkir-3.1.0-rc.1` |
| compact-runtime / compact-js / ledger-v9 | 0.20.0 / 3.0.0-rc.3 / 1.0.0-rc.5 |
| midnight-js | 5.0.0-rc.2 |
| Wallet SDK | 2.0.0-beta.2 (the 2.0.0-rc line cannot sync against indexer 4.4.0-rc.1, which Stagenet runs) |
| Local chain | `midnight-node` 2.0.0-rc.4, `indexer-standalone` 4.4.0-rc.1 |
| Proof servers | `proof-server` 9.0.0-rc.8 for contract circuits (reads ZKIR 3.1) and 9.0.0-rc.6 for wallet DUST spends (the only one whose DUST proofs node 2.0.0-rc.4 accepts) |
| OpenZeppelin Compact Contracts | 0.4.0-alpha.5 |
| Node.js | 24 (`node:24-bookworm`, pinned by digest) |

## MIP section → repository path

| MIP section | Implemented / tested in | Status |
|---|---|---|
| Event (name, ignore rule) | `packages/codec`, `packages/consumer`, `vectors/` (ignore vectors) | planned (S1) |
| Payload (layout, the three checks) | `packages/codec`; `vectors/payload/` (A1–A5, R1–R6) | planned (S1) |
| Payload (Compact emitter) | `packages/compact` (typed builders + pure-circuit alternative); toolchain gate: `test-contracts/toolchain-spike` | spike done (S0); module planned (S2) |
| Value types | `packages/codec` (strict UTF-8, JSON, RFC 3986 `URI`, integers 1–31 bytes, Null); `vectors/informative/uri/` | planned (S1) |
| Token identity and authority, Lookup | `packages/consumer` (identity), `packages/midnight` (`tokenType`, mint scanner), `packages/cli` (`index`, `lookup`) | planned (S1, S4) |
| Keys, Applying records, Common fields, Symbol grouping | `packages/consumer`; `vectors/state/` (S1–S9) | planned (S1) |
| Publishing | `packages/compact`, `examples/minimal`, `examples/openzeppelin/*`, `packages/cli` (`deploy`, `publish`) | planned (S2–S4) |
| Consuming | `packages/consumer`, `packages/midnight`, `packages/cli` (`verify`, `list`) | planned (S1, S4) |
| Limitations | `vectors/payload/` (A2 capacity); `docs/costs.md` | planned (S1, S2) |
| Backwards Compatibility — Existing contracts | `examples/upgrade-existing-contract`, `docs/upgrade-guide.md` | planned (S6) |
| Security Considerations | `docs/consumer-guide.md`, [`SECURITY.md`](SECURITY.md) | planned (S4) |
| Testing (normative vectors) | `vectors/` + runner contract | planned (S1) |
| Implementation Plan step 3 (public test network) | [`deployments/stagenet/`](deployments/stagenet/README.md) | S0-SPIKE + matrix C01–C10 and IDX run on Stagenet 2026-10-02, each re-checkable wallet-free (S5); upgrade case U1 (S6b) |
| Every MUST / SHOULD | [`docs/conformance-matrix.md`](docs/conformance-matrix.md) | skeleton (S0) |

## Quickstart (Docker only)

Everything builds and runs in Docker; nothing is installed on the host.

```sh
docker/run.sh ci                          # npm ci in the pinned image
docker/run.sh lint typecheck test         # static checks and unit tests
docker/run.sh check:pins check:mip-pin check:conformance-matrix
docker/run.sh compile:spike               # Compact 0.35.0 + ZKIR v3, full keys

docker/local-stack/up.sh                  # local undeployed chain (official images)
. docker/local-stack/ports.env
MIP0018_DOCKER_NETWORK=$MIP0018_STACK_NETWORK docker/run.sh spike:local
docker/local-stack/down.sh
```

Walkthroughs for issuers and consumers come with S4.

## Repository layout

```
docker/            pinned toolchain image, run.sh / signer.sh, local-stack/ (official images by digest)
docs/              conformance matrix; guides and costs (planned)
packages/          compact, codec, consumer, midnight, cli (planned)
examples/          minimal, openzeppelin/*, upgrade-existing-contract, publish-and-emit, verify (planned)
vectors/           normative and informative test vectors (planned, S1)
test-contracts/    toolchain-spike (S0 gate), raw-emitter (planned, negative cases)
deployments/       stagenet/ real cases
tools/             repository checks (pins, MIP hash, conformance matrix)
```

## Contributing, security, licence

See [`CONTRIBUTING.md`](CONTRIBUTING.md) (Docker-only workflow, how to add a note to `MIP-PROPOSAL-NOTES.md`) and [`SECURITY.md`](SECURITY.md) (secrets, untrusted payloads, reporting). Licensed under the [Apache License 2.0](LICENSE).
