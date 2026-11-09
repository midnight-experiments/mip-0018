# MIP-0018 reference implementation

Reference implementation of **MIP-0018: On-chain token metadata** for Midnight: test vectors, a Compact module that
emits the metadata event, OpenZeppelin-based examples, a reference consumer, and wallet-free tools to check events, list and
look up metadata on a local chain or on the public networks (`preview`, `preprod`, `mainnet`).

Every MIP section below has code and tests, on a local chain where a chain is involved; every MUST and SHOULD is in the
[conformance matrix](docs/conformance-matrix.md), with its tests or the reason it is not testable here.

## Where to start

| You are | Read |
|---|---|
| A token issuer adding metadata to a contract | [Issuer guide](docs/issuer-guide.md), then [`examples/publish-and-emit`](examples/publish-and-emit/README.md) |
| A wallet, explorer or indexer developer | [Consumer guide](docs/consumer-guide.md), then [`examples/verify`](examples/verify/README.md) and the [vectors](vectors/README.md) |
| The maintainer of an already-deployed token | [Upgrade guide](docs/upgrade-guide.md) |
| A MIP reviewer | [conformance matrix](docs/conformance-matrix.md), [costs](docs/costs.md) |

## The MIP this repository implements

| | |
|---|---|
| Proposal | [midnightntwrk/midnight-improvement-proposals PR #372](https://github.com/midnightntwrk/midnight-improvement-proposals/pull/372) |
| Pinned text | [`338ea194bbe7c4e5d1829234a503b7c1b11ebf0f` `mips/mip-0018-on-chain-token-metadata.md`](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/338ea194bbe7c4e5d1829234a503b7c1b11ebf0f/mips/mip-0018-on-chain-token-metadata.md) |
| SHA-256 of the pinned text | `8d4204e7aa24428faa44740ba99612f5556f628347c50e38903e4bea83f17245` (`docker/run.sh check:mip-pin` checks it, that the vectors, schemas and the committed cases cite this commit, and that no tracked file cites another commit of the MIP text) |
| Authority | The pinned text decides every byte and rule. |

## MIP section → repository

| MIP section | Implementation | Tests | Status |
|---|---|---|---|
| Event (name, "must ignore") | [`packages/codec`](packages/codec/README.md) `classifyEvent` | vectors `I1a`–`I3` ([codec](packages/codec/test/vectors.test.ts), [consumer](packages/consumer/test/vectors.test.ts)) | done |
| Payload (layout, the three checks, whole-event rejection) | [`packages/codec`](packages/codec/README.md) `decodePayload`, `encodePayload` | vectors `A1`–`A6`, `R1`–`R6`; [fuzz](packages/codec/test/fuzz.test.ts); [rule mutations](packages/consumer/test/mutations.test.ts) | done |
| Payload — Compact emitter ("exactly these bytes") | [`packages/compact`](packages/compact/README.md): typed constructor (default) + pure-circuit alternative | [byte equality with the vectors](packages/compact/test/vectors.test.ts), [729 generated payloads](packages/compact/test/equivalence.test.ts), [16 compile errors](packages/compact/test/compile-fail.test.ts) | done |
| Value types (incl. the RFC 3986 `URI` rule; JSON checked with the platform's JSON parser) | [`packages/codec`](packages/codec/README.md) `checkValue`, `isRfc3986Uri` | [values](packages/codec/test/values.test.ts), [URI](packages/codec/test/uri.test.ts); vectors `R5a`–`R5h`, [26 informative URI cases](vectors/informative/uri/README.md) | done |
| Token identity and authority; Lookup | [`packages/consumer`](packages/consumer/README.md) (identity), [`packages/midnight`](packages/midnight/README.md) (`tokenType`, mint scanner), CLI `index` / `lookup` | [colors and raw mints](packages/midnight/test/raw-color.test.ts), [scanner](packages/midnight/test/check-event-list-scan.test.ts); vectors `S6a`, `S6b`; the color tests of the shielded/unshielded examples | done |
| Keys (valid UTF-8; only the common keys and the keys of declared standards are served), Applying records (a Null record deletes its field; an identity with no field left is not referenced), Common fields (incl. `image`, `image_sha256`; `name`/`symbol` truncated to 64/12 characters), Symbol grouping | [`packages/consumer`](packages/consumer/README.md) `MetadataState` (`definedKeys`, `imageContentAllowed`), `formatAmount`, `parseStandards`, `characters`; `withdraw`, `imageRecord`, `imageSha256Record` in [`packages/compact`](packages/compact/README.md), `withdrawRecords()` and `record.image`/`imageSha256` in [`packages/codec`](packages/codec/README.md) | vector `R5i`; state vectors `S1`–`S12` ([consumer](packages/consumer/test/vectors.test.ts)), [state](packages/consumer/test/state.test.ts), [served keys, lengths, image](packages/consumer/test/served.test.ts), [common fields](packages/consumer/test/common.test.ts), [rule mutations](packages/consumer/test/mutations.test.ts) | done |
| Publishing (no events in normal operation; access control; few events) | [`packages/compact`](packages/compact/README.md), [`examples/minimal`](examples/minimal/README.md), [`examples/openzeppelin`](examples/openzeppelin/README.md), CLI `deploy` / `publish` / `remove-circuit` / `deploy-and-publish` | [minimal](examples/minimal/test/minimal.test.ts), OpenZeppelin examples' tests, [signer units](packages/midnight/test/signer-units.test.ts); local chain: [`examples-e2e.sh`](packages/cli/test/e2e/examples-e2e.sh), [`local-e2e.sh`](packages/cli/test/e2e/local-e2e.sh) | done |
| Consuming (reading events, including zero-extending a short `name`/`payload`; completeness; untrusted input) | [`packages/codec`](packages/codec/README.md) `zeroExtend`, `classifyEvent`; [`packages/midnight`](packages/midnight/README.md) `checkEvent`, `list`; CLI `check-event` / `list` / `recheck` | [zero extension](packages/codec/test/zero-extension.test.ts) and informative vectors `INF-ZEXT-*`, [check-event and list](packages/midnight/test/check-event-list-scan.test.ts), [CLI](packages/cli/test/cli.test.ts), [fuzz](packages/codec/test/fuzz.test.ts) | done |
| Limitations (219-byte value, one identity per event) | [`packages/compact`](packages/compact/README.md) (size errors at compile time) | vectors `A2a`, `A2b`, `R2a`–`R2f` | done |
| Off-chain content (`image` + `image_sha256` follow it) | [`packages/consumer`](packages/consumer/README.md) `imageContentAllowed` | vectors `A6`, `S12a`, `S12b`; the requirement on future MIPs is not testable here ([C-035](docs/conformance-matrix.md)) | done |
| Backwards compatibility — Existing contracts | [`examples/upgrade-existing-contract`](examples/upgrade-existing-contract/README.md), CLI `upgrade`, [upgrade guide](docs/upgrade-guide.md) | [upgrade](examples/upgrade-existing-contract/test/upgrade.test.ts), [layout](examples/upgrade-existing-contract/test/layout.test.ts); local chain: [`local-upgrade.sh`](examples/upgrade-existing-contract/scripts/local-upgrade.sh) | done |
| Security Considerations | [consumer guide §6–7](docs/consumer-guide.md#6-untrusted-input), [`SECURITY.md`](SECURITY.md) | matrix rows C-036–C-039 | done (curation and image rendering: not testable here) |
| Testing (normative vectors) | [`vectors/`](vectors/README.md): 78 normative + 49 informative, JSON Schemas, independent generator, [runner contract](vectors/README.md#runner-contract) (S8, S9 and S12a as the MIP scopes them: a consumer without display, groups or images passes; S10b–S10e carry the test standard they define) | reference consumer 78/78 ([`vectors.test.ts`](packages/consumer/test/vectors.test.ts)), [runner rules](packages/consumer/test/runner-rules.test.ts); [generator `--check`](vectors/test/generate.test.ts) | done |
| Implementation Plan 1 — Compact module and example issuers | [`packages/compact`](packages/compact/README.md), [`examples/`](examples/minimal/README.md) | as above | done |
| Implementation Plan 2 — vectors and a reference decoder; a second reader | [`vectors/`](vectors/README.md), [`packages/codec`](packages/codec/README.md), [`packages/consumer`](packages/consumer/README.md) | as above | done; a second, independent consumer: not provided |
| Implementation Plan 3 — a publisher on a public test network | network profiles `preview` / `preprod` / `mainnet` in [`packages/midnight`](packages/midnight/README.md); case folders from [`deployments/tools/prepare-cases.ts`](deployments/tools/prepare-cases.ts) (preview: [`deployments/preview`](deployments/preview/README.md)), network identity from [`deployments/tools/network-identity.ts`](deployments/tools/network-identity.ts) | [profiles and tokens](packages/midnight/test/network.test.ts), [case generator](packages/cli/test/cases.test.ts); local chain: [`token-e2e.sh`](packages/cli/test/e2e/token-e2e.sh); `recheck` per case | done |
| Implementation Plan 4 — propose the module to OpenZeppelin | [`examples/openzeppelin`](examples/openzeppelin/README.md) shows the extension | — | not pursued: this repository makes no upstream contributions |
| Implementation Plan 5 — upgrade template on a public test network | [`examples/upgrade-existing-contract`](examples/upgrade-existing-contract/README.md) | as above | done |
| Every MUST / SHOULD | [`docs/conformance-matrix.md`](docs/conformance-matrix.md) | `docker/run.sh check:conformance-matrix` | 40 rows: 33 covered, 7 not testable here |

## Quickstart (Docker only)

Everything builds and runs in Docker; nothing is installed on the host. From a fresh clone:

```sh
git clone https://github.com/midnight-experiments/mip-0018.git && cd mip-0018
docker/run.sh ci                                   # builds the pinned image (first run), then npm ci
docker/run.sh lint typecheck test                  # static checks and every unit/runtime test (no chain)
docker/run.sh check:pins check:mip-pin check:conformance-matrix check:md-links
docker/run.sh mip0018 -- vectors run               # the normative vectors against the reference consumer
```

A local chain of official `midnightntwrk/*` images (node 2.1.101, indexer-standalone 4.4.101, proof server 9.0.1)
runs the issuer side without funds; the full walkthrough is
[`examples/publish-and-emit`](examples/publish-and-emit/README.md):

```sh
docker/run.sh compile:spike               # compile the spike contract with keys (needed once per clone)
docker/local-stack/up.sh                  # random loopback ports ≥ 10000
. docker/local-stack/ports.env
MIP0018_DOCKER_NETWORK=$MIP0018_STACK_NETWORK docker/run.sh spike:local
docker/local-stack/down.sh
```

`docker/run.sh` names every container and volume after `MIP0018_DOCKER_PREFIX` (default: a hash of the checkout path),
so teardown removes exactly what it created ([`CONTRIBUTING.md`](CONTRIBUTING.md)).

## Toolchain

MIP-0018 needs MIP-0002 `Misc` events, so it **requires Compact 0.34.0 or later** (language 0.26.0, runtime 0.19.0 or
later — the MIP's Dependencies line).
This repository is **built and tested with Compact 0.36.0** (language 0.28.0, runtime 0.21.0), whose only backend is
ZKIR v3 (no compiler flag), pinned with every other version in [`toolchain.json`](toolchain.json). Only official
binaries are used: the Compact release from `midnightntwrk/compact`, `midnightntwrk/*` Docker images pinned by digest,
and packages from the `@midnight-ntwrk`, `@midnightntwrk` and `@openzeppelin` npm scopes.

| Piece | Version |
|---|---|
| Compact | 0.36.0 (`b5d9e4df`); its bundled `zkir-v3` is `zkir-3.2.0-rc.2` |
| compact-runtime / compact-js | 0.21.0 / 3.0.0 |
| ledger-v9 / onchain-runtime-v4 | 1.0.1 / 4.0.1, by root `overrides` (see below) |
| midnight-js | 5.0.0 |
| Wallet SDK | 2.0.0 (facade 5.0.0) |
| Local chain | `midnight-node` 2.1.101, `indexer-standalone` 4.4.101 |
| Proof server | `proof-server` 9.0.1, one for contract circuits and the wallet's DUST spends |
| OpenZeppelin Compact Contracts | 0.5.0-alpha.2 |
| Node.js | 24 (`node:24-bookworm`, pinned by digest) |

**Ledger override.** midnight-js 5.0.0 declares `@midnightntwrk/ledger-v9` 1.0.0 and `@midnightntwrk/onchain-runtime-v4`
4.0.0. The root [`package.json`](package.json) `overrides` replace them with **1.0.1 / 4.0.1**: node 2.1.101, which the
public networks run, runs ledger 9.1.0.1, and that ledger prices transactions above what 1.0.0 computes — a
`VerifierKeyRemove` balanced with 1.0.0 underpays its DUST fee and the node rejects it (`BalanceCheckOverspend`).
`npm ls` therefore prints `overridden` for both packages. `npm run check:pins` fails unless the install holds exactly
one copy of each, at the pinned version (two copies of the ledger WASM make every contract call fail).

Compiled output (`managed/`: keys, ZKIR, generated JavaScript) is not committed: builds are deterministic, and the
verifier-key SHA-256 of every measured circuit is in [`docs/costs.json`](docs/costs.json).

## Repository layout

```
docker/            pinned toolchain image, run.sh (wallet-free) / signer.sh (signing), local-stack/ (official images by digest)
docs/              issuer, consumer and upgrade guides; conformance matrix; costs
vectors/           78 normative + 49 informative test vectors, JSON Schemas, generator, runner
packages/          compact (the Compact module), codec, consumer, midnight (chain access, scanner, signer), cli (mip0018)
examples/          minimal, openzeppelin/*, upgrade-existing-contract, publish-and-emit, verify
test-contracts/    toolchain-spike (toolchain gate), raw-emitter (TEST ONLY: malformed and foreign events), scanner-mints
deployments/       preview/ — the cases on preview (case folders, run records, observations); tools/ — case folders per
                   public network (prepare-cases.ts) and network identity (network-identity.ts)
tools/             repository checks (pins, MIP hash, conformance matrix, Markdown links, secrets)
```

## Contributing, security, licence

See [`CONTRIBUTING.md`](CONTRIBUTING.md) (Docker-only workflow) and
[`SECURITY.md`](SECURITY.md) (secrets, untrusted payloads, reporting). Licensed under the [Apache License 2.0](LICENSE).
