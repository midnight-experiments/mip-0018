# MIP-0018 reference implementation

Reference implementation of **MIP-0018: On-chain token metadata** for Midnight: test vectors, a Compact module that
emits the metadata event, OpenZeppelin-based examples, a reference consumer, wallet-free tools to verify, list and look
up metadata, and real cases on Stagenet.

> **Status: complete — draft PR, awaiting review** ([PR #1](https://github.com/midnight-experiments/mip-0018/pull/1)).
> Every MIP section below has code, tests and, where a chain is involved, a recorded Stagenet case; every MUST/SHOULD
> is in the [conformance matrix](docs/conformance-matrix.md) (29 covered, 6 not testable here, each with the reason).

## Where to start

| You are | Read |
|---|---|
| A token issuer adding metadata to a contract | [Issuer guide](docs/issuer-guide.md), then [`examples/publish-and-emit`](examples/publish-and-emit/README.md) |
| A wallet, explorer or indexer developer | [Consumer guide](docs/consumer-guide.md), then [`examples/verify`](examples/verify/README.md) and the [vectors](vectors/README.md) |
| The maintainer of an already-deployed token | [Upgrade guide](docs/upgrade-guide.md) |
| A MIP reviewer | [Stagenet cases](deployments/stagenet/README.md), [conformance matrix](docs/conformance-matrix.md), [costs](docs/costs.md) |

## The MIP this repository implements

| | |
|---|---|
| Proposal | [midnightntwrk/midnight-improvement-proposals PR #340](https://github.com/midnightntwrk/midnight-improvement-proposals/pull/340) — "Update MIP-0018 with community feedback" (the final version of the MIP text, per the owner) |
| Pinned text | [`274a84f221bcfc17e4b73e2c8b32fd8c028ea092` `mips/mip-0018-on-chain-token-metadata.md`](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/274a84f221bcfc17e4b73e2c8b32fd8c028ea092/mips/mip-0018-on-chain-token-metadata.md) — the head of PR #340 on 2026-10-02: a Null record deletes its own field (per-key tombstones), and a token identity with no field left is not referenced at all |
| SHA-256 of the pinned text | `e64fe1429b9f7589077f1323572cf5c3ffa90c7c96690242a9e76d2658058d8b` (`docker/run.sh check:mip-pin` also checks that the vectors, schemas and docs cite this pin) |
| Previous pins | [`78ecbb4b1ba57371e84fe45f705991ab7b996a61`](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/78ecbb4b1ba57371e84fe45f705991ab7b996a61/mips/mip-0018-on-chain-token-metadata.md) (SHA-256 `b9092746ecf5660496535688a2dea152eb23d932b6eeb6b5a182c23426eec1a1`): a Null record at any key withdrew the whole identity. Before it, [`b147c627e1bb15b5d15cc73cf30c2a36afd34dbb`](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/b147c627e1bb15b5d15cc73cf30c2a36afd34dbb/mips/mip-0018-on-chain-token-metadata.md) (SHA-256 `9ffba7e6a3123cd6683e5a779ac3b73c8a31a9724367cd98ee120be78720d842`): the text the Stagenet cases C01–C10, IDX and U1 were prepared under. The payload layout and its validation rules did not change across the three pins; `78ecbb4` added the consumer rule to zero-extend a short `name`/`payload` before decoding, `274a84f` changed how Null records apply |
| Authority | The pinned text decides every byte and rule. The findings from building this reference were folded into the MIP text itself (PR #340). |

## MIP section → repository

| MIP section | Implementation | Tests | Stagenet | Status |
|---|---|---|---|---|
| Event (name, "must ignore") | [`packages/codec`](packages/codec/README.md) `classifyEvent` | vectors `I1a`–`I3` ([codec](packages/codec/test/vectors.test.ts), [consumer](packages/consumer/test/vectors.test.ts)) | [C07](deployments/stagenet/cases/C07/README.md) (`[v2]` and foreign names) | done |
| Payload (layout, the three checks, whole-event rejection) | [`packages/codec`](packages/codec/README.md) `decodePayload`, `encodePayload` | vectors `A1`–`A5`, `R1`–`R6`; [fuzz](packages/codec/test/fuzz.test.ts); [rule mutations](packages/consumer/test/mutations.test.ts) | [C07](deployments/stagenet/cases/C07/README.md), [C08](deployments/stagenet/cases/C08/README.md) | done |
| Payload — Compact emitter ("exactly these bytes") | [`packages/compact`](packages/compact/README.md): typed constructor (default) + pure-circuit alternative | [byte equality with the vectors](packages/compact/test/vectors.test.ts), [729 generated payloads](packages/compact/test/equivalence.test.ts), [16 compile errors](packages/compact/test/compile-fail.test.ts) | [C06](deployments/stagenet/cases/C06/README.md), [C10](deployments/stagenet/cases/C10/README.md) (Appendix A bytes on chain) | done |
| Value types (incl. the RFC 3986 `URI` rule — MIP text since `78ecbb4`, owner ruling Q20; JSON via the platform parser) | [`packages/codec`](packages/codec/README.md) `checkValue`, `isRfc3986Uri` | [values](packages/codec/test/values.test.ts), [URI](packages/codec/test/uri.test.ts); vectors `R5a`–`R5h`, [26 informative URI cases](vectors/informative/uri/README.md) | [C07](deployments/stagenet/cases/C07/README.md) | done |
| Token identity and authority; Lookup | [`packages/consumer`](packages/consumer/README.md) (identity), [`packages/midnight`](packages/midnight/README.md) (`tokenType`, mint scanner), CLI `index` / `lookup` | [colors and raw mints](packages/midnight/test/raw-color.test.ts), [scanner](packages/midnight/test/verify-list-scan.test.ts); vectors `S6a`, `S6b`; native examples' color tests | [C02](deployments/stagenet/cases/C02/README.md)–[C05](deployments/stagenet/cases/C05/README.md), [IDX](deployments/stagenet/cases/IDX/README.md), [U1](deployments/stagenet/cases/U1/README.md) | done |
| Keys, Applying records (per-key tombstones since `274a84f`: a Null record deletes its field; an identity with no field left is not referenced), Common fields, Symbol grouping | [`packages/consumer`](packages/consumer/README.md) `MetadataState`, `formatAmount`, `parseStandards`; `withdraw` in [`packages/compact`](packages/compact/README.md), `withdrawRecords()` in [`packages/codec`](packages/codec/README.md) | state vectors `S1`–`S9` ([consumer](packages/consumer/test/vectors.test.ts)), [state](packages/consumer/test/state.test.ts), [common fields](packages/consumer/test/common.test.ts), [rule mutations](packages/consumer/test/mutations.test.ts) | [C04](deployments/stagenet/cases/C04/README.md) (group), [C05](deployments/stagenet/cases/C05/README.md), [C06](deployments/stagenet/cases/C06/README.md) (lifecycle; a Null at `name`), [C11](deployments/stagenet/cases/C11/README.md) (full withdrawal) | done |
| Publishing (no events in normal operation; access control; few events) | [`packages/compact`](packages/compact/README.md), [`examples/minimal`](examples/minimal/README.md), [`examples/openzeppelin`](examples/openzeppelin/README.md), CLI `deploy` / `publish` / `remove-circuit` / `deploy-and-publish` | [minimal](examples/minimal/test/minimal.test.ts), OpenZeppelin examples' tests, [signer units](packages/midnight/test/signer-units.test.ts); local chain: [`examples-e2e.sh`](packages/cli/test/e2e/examples-e2e.sh), [`local-e2e.sh`](packages/cli/test/e2e/local-e2e.sh) | [C01](deployments/stagenet/cases/C01/README.md)–[C06](deployments/stagenet/cases/C06/README.md), [C09](deployments/stagenet/cases/C09/README.md) (non-owner refused), [C10](deployments/stagenet/cases/C10/README.md) (create and destroy), [C11](deployments/stagenet/cases/C11/README.md) | done |
| Consuming (reading events — zero-extend a short `name`/`payload`, a MUST since `78ecbb4` —, completeness, untrusted input) | [`packages/codec`](packages/codec/README.md) `zeroExtend`, `classifyEvent`; [`packages/midnight`](packages/midnight/README.md) `verify`, `list`; CLI `verify` / `list` / `recheck` | [zero extension](packages/codec/test/zero-extension.test.ts) and informative vectors `INF-ZEXT-*`, [verify and list](packages/midnight/test/verify-list-scan.test.ts), [CLI](packages/cli/test/cli.test.ts), [fuzz](packages/codec/test/fuzz.test.ts) | every case: `recheck` | done |
| Limitations (219-byte value, one identity per event) | [`packages/compact`](packages/compact/README.md) (size errors at compile time) | vectors `A2a`, `A2b`, `R2a`–`R2f` | [C07](deployments/stagenet/cases/C07/README.md) (`A2a`, `A2b`) | done |
| Off-chain content | — (a requirement on future MIPs) | not testable here ([C-032](docs/conformance-matrix.md)) | — | n/a |
| Backwards compatibility — Existing contracts | [`examples/upgrade-existing-contract`](examples/upgrade-existing-contract/README.md), CLI `upgrade`, [upgrade guide](docs/upgrade-guide.md) | [upgrade](examples/upgrade-existing-contract/test/upgrade.test.ts), [layout](examples/upgrade-existing-contract/test/layout.test.ts); local chain: [`local-upgrade.sh`](examples/upgrade-existing-contract/scripts/local-upgrade.sh) | [U1](deployments/stagenet/cases/U1/README.md) | done |
| Security Considerations | [consumer guide §6–7](docs/consumer-guide.md#6-untrusted-input), [`SECURITY.md`](SECURITY.md) | matrix rows C-033–C-035 | [C09](deployments/stagenet/cases/C09/README.md) | done (curation: not testable here) |
| Testing (normative vectors) | [`vectors/`](vectors/README.md): 67 normative + 43 informative, JSON Schemas, independent generator, [runner contract](vectors/README.md#runner-contract) (S8 and S9 as the MIP scopes them since `78ecbb4`: a consumer without display or without groups passes) | reference consumer 67/67 ([`vectors.test.ts`](packages/consumer/test/vectors.test.ts)), [runner rules](packages/consumer/test/runner-rules.test.ts); [generator `--check`](vectors/test/generate.test.ts) | [C07](deployments/stagenet/cases/C07/README.md) (22 vectors on chain) | done |
| Implementation Plan 1 — Compact module and example issuers | [`packages/compact`](packages/compact/README.md), [`examples/`](examples/minimal/README.md) | as above | [C01](deployments/stagenet/cases/C01/README.md)–[C06](deployments/stagenet/cases/C06/README.md), [C10](deployments/stagenet/cases/C10/README.md), [C11](deployments/stagenet/cases/C11/README.md) | done |
| Implementation Plan 2 — vectors and a reference decoder; a second reader | [`vectors/`](vectors/README.md), [`packages/codec`](packages/codec/README.md), [`packages/consumer`](packages/consumer/README.md) | as above | — | done; a second, independent consumer is left open (question Q7) |
| Implementation Plan 3 — a publisher on a public test network | [`deployments/stagenet/`](deployments/stagenet/README.md) | `recheck` per case | 13 cases | done |
| Implementation Plan 4 — propose the module to OpenZeppelin | [`examples/openzeppelin`](examples/openzeppelin/README.md) shows the extension | — | — | not pursued: no upstream contribution from this repository (owner decision Q6) |
| Implementation Plan 5 — upgrade template on a public test network | [`examples/upgrade-existing-contract`](examples/upgrade-existing-contract/README.md) | as above | [U1](deployments/stagenet/cases/U1/README.md) | done |
| Every MUST / SHOULD | [`docs/conformance-matrix.md`](docs/conformance-matrix.md) | `docker/run.sh check:conformance-matrix` | — | 36 rows: 30 covered, 6 not testable here |

## Stagenet cases

Thirteen cases deployed and emitted on Stagenet — twelve on 2026-10-02 (57 transactions, 54.69 DUST) and C11 on
2026-10-03 (5 transactions, 4.97 DUST) — each recorded in its folder with the expected consumer conclusion written
before the transactions (C06's states were re-derived after the MIP changed; see its README), and each re-checkable by
anyone with one wallet-free command:

```sh
docker/run.sh mip0018 -- recheck --network stagenet --case deployments/stagenet/cases/C06
```

| Case | Shows |
|---|---|
| [C01](deployments/stagenet/cases/C01/README.md)–[C03](deployments/stagenet/cases/C03/README.md) | OpenZeppelin fungible (kind 3), native shielded (kind 1), native unshielded (kind 2); colors equal the minted coins' |
| [C04](deployments/stagenet/cases/C04/README.md), [C05](deployments/stagenet/cases/C05/README.md) | one asset as kinds 1, 2, 3 (one symbol group); a token family (three `domainSep`) |
| [C06](deployments/stagenet/cases/C06/README.md) | lifecycle: publish (Appendix A bytes), rename, withdraw (the contract of that time: one Null at `name`), withdraw again, revive |
| [C11](deployments/stagenet/cases/C11/README.md) | full withdrawal with the current `OwnerKey`: one event, four Null records — the token is no longer listed; withdraw again; revive with only `name` and `symbol` |
| [C07](deployments/stagenet/cases/C07/README.md), [C08](deployments/stagenet/cases/C08/README.md) | test-only raw emitter: 22 vectors accepted / rejected / ignored on chain; two events in one transaction |
| [C09](deployments/stagenet/cases/C09/README.md), [C10](deployments/stagenet/cases/C10/README.md) | a non-owner refused; create and destroy |
| [IDX](deployments/stagenet/cases/IDX/README.md), [U1](deployments/stagenet/cases/U1/README.md) | mint scanner + color lookup; adding `publishMetadata()` to a deployed token |

Network identity, contracts, transactions, fees and limitations: [`deployments/stagenet/README.md`](deployments/stagenet/README.md).
Fees and circuit sizes: [`docs/costs.md`](docs/costs.md) (a metadata transaction ≈ 0.17–0.19 DUST on Stagenet).

## Quickstart (Docker only)

Everything builds and runs in Docker; nothing is installed on the host. From a fresh clone:

```sh
git clone https://github.com/midnight-experiments/mip-0018.git && cd mip-0018
docker/run.sh ci                                   # builds the pinned image (first run), then npm ci
docker/run.sh lint typecheck test                  # static checks and every unit/runtime test (no chain)
docker/run.sh check:pins check:mip-pin check:conformance-matrix check:md-links
docker/run.sh mip0018 -- vectors run               # the normative vectors against the reference consumer
docker/run.sh mip0018 -- recheck --network stagenet --case deployments/stagenet/cases/C06   # a real case, wallet-free
```

A local chain of official `midnightntwrk/*` images (node 2.0.0-rc.4, indexer-standalone 4.4.0-rc.1, the two proof
servers) runs the issuer side without funds; the full walkthrough is
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
later — the MIP's Dependencies line since `78ecbb4`).
This repository is **built and tested with Compact 0.35.0** (language 0.27.0, runtime 0.20.0) **and ZKIR v3**
(`--feature-zkir-v3`), pinned with every other version in [`toolchain.json`](toolchain.json). Only official binaries
are used: the Compact release from `midnightntwrk/compact`, `midnightntwrk/*` Docker images pinned by digest, and
packages from the `@midnight-ntwrk`, `@midnightntwrk` and `@openzeppelin` npm scopes.

| Piece | Version |
|---|---|
| Compact | 0.35.0 (`debb05f9`), ZKIR v3 = `zkir-3.1.0-rc.1` |
| compact-runtime / compact-js / ledger-v9 | 0.20.0 / 3.0.0-rc.3 / 1.0.0-rc.5 |
| midnight-js | 5.0.0-rc.2 |
| Wallet SDK | 2.0.0-beta.2 (the 2.0.0-rc line cannot sync against indexer 4.4.0-rc.1, which Stagenet runs; Q22) |
| Local chain | `midnight-node` 2.0.0-rc.4, `indexer-standalone` 4.4.0-rc.1 |
| Proof servers | `proof-server` 9.0.0-rc.8 for contract circuits (reads ZKIR 3.1) and 9.0.0-rc.6 for wallet DUST spends (the only one whose DUST proofs node 2.0.0-rc.4 accepts; Q21) |
| OpenZeppelin Compact Contracts | 0.4.0-alpha.5 |
| Node.js | 24 (`node:24-bookworm`, pinned by digest) |

Compiled output (`managed/`: keys, ZKIR, generated JavaScript) is not committed: builds are deterministic, and the
verifier-key SHA-256 of every measured circuit is in [`docs/costs.json`](docs/costs.json) (Q24).

## Repository layout

```
docker/            pinned toolchain image, run.sh (wallet-free) / signer.sh (signing), local-stack/ (official images by digest)
docs/              issuer, consumer and upgrade guides; conformance matrix; costs
vectors/           67 normative + 43 informative test vectors, JSON Schemas, generator, runner
packages/          compact (the Compact module), codec, consumer, midnight (chain access, scanner, signer), cli (mip0018)
examples/          minimal, openzeppelin/*, upgrade-existing-contract, publish-and-emit, verify
test-contracts/    toolchain-spike (S0 gate), raw-emitter (TEST ONLY: malformed and foreign events), scanner-mints
deployments/       stagenet/ — 12 recorded cases, each re-checkable wallet-free
tools/             repository checks (pins, MIP hash, conformance matrix, Markdown links, secrets)
```

Question numbers (Qn) refer to the owner decisions recorded while building this repository; each is summarised where
it is cited.

## Contributing, security, licence

See [`CONTRIBUTING.md`](CONTRIBUTING.md) (Docker-only workflow) and
[`SECURITY.md`](SECURITY.md) (secrets, untrusted payloads, reporting). Licensed under the [Apache License 2.0](LICENSE).
