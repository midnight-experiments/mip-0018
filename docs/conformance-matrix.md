# Conformance matrix — MIP-0018

Every MUST and SHOULD sentence of the pinned MIP text, with the test(s) that cover it in this repository or an explicit "not testable here".

| | |
|---|---|
| MIP text | [`midnightntwrk/midnight-improvement-proposals@b147c627e1bb15b5d15cc73cf30c2a36afd34dbb` `mips/mip-0018-on-chain-token-metadata.md`](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/b147c627e1bb15b5d15cc73cf30c2a36afd34dbb/mips/mip-0018-on-chain-token-metadata.md), SHA-256 `9ffba7e6a3123cd6683e5a779ac3b73c8a31a9724367cd98ee120be78720d842` (linked through [PR #340](https://github.com/midnightntwrk/midnight-improvement-proposals/pull/340)) |
| Rows | 32 (extracted mechanically: every sentence or table row containing MUST or SHOULD, outside code blocks, except the RFC 2119 boilerplate) |
| Check | `docker/run.sh check:conformance-matrix` fails if a row is missing, extra, or differs from the MIP text |
| Regenerate the rows | `docker/run.sh exec node tools/check-conformance-matrix.mjs --print` |

Status values: `planned (Sn)` — the phase that adds the test; `partial (S0)` — evidence exists, the full test lands later; `covered` — a test in this repository passes; `not testable here` — reason given.

| ID | MIP section | Level | Requirement (verbatim) | Covered by | Status |
|---|---|---|---|---|---|
| C-001 | Event | MUST | Consumers MUST ignore `Misc` events with any other name, including other versions of this one. | S1: "ignore" vectors (other names, `[v2]`); S5: foreign and `[v2]` events on Stagenet | planned |
| C-002 | Event | MUST | An event with this name whose payload cannot be decoded as defined in this MIP is invalid: consumers MUST NOT consider it, and none of its records are applied. | S1: R1–R6 (whole event rejected, no record applied) | planned |
| C-003 | Payload | MUST | A consumer MUST check a payload as follows. | S1: A1–A5 accept, R1–R6 reject (the three checks) | planned |
| C-004 | Payload | MUST | If any check fails, it MUST reject the whole event and apply none of its records. | S1: R1–R6, S7 (two events in one transaction, one malformed) | planned |
| C-005 | Payload | MUST | Every emitter MUST produce exactly these bytes, whatever its toolchain. | S0: SpikeEmitter emits A1 byte-for-byte (local stack + Stagenet indexer); S2: module byte equality with every A-vector | partial (S0) |
| C-006 | Value types | MUST | Consumers MUST decode integers of every permitted width and MUST NOT reinterpret a value as a different type. | S1: integer widths 1–31 (A4 and informative), no type reinterpretation | planned |
| C-007 | Token identity and authority | MUST | Consumers MUST take it from the event record, never from the payload, so a contract can describe only its own tokens. | S1: consumer takes the address from the event record; S4: `verify`; S5: Stagenet cases | planned |
| C-008 | Token identity and authority | MUST | A color MUST always be computed this way, never read from a value. | S1: `tokenType` equals Compact; S4: mint scanner cross-check against real mints | planned |
| C-009 | Keys | MUST/SHOULD | Keys SHOULD be UTF-8, but consumers MUST NOT reject an event because a key is not UTF-8. | S1: non-UTF-8 key vector (accepted) | planned |
| C-010 | Applying records | MUST | For every token it tracks, a consumer's state MUST equal the result of applying, in that order, every accepted event on the canonical chain. | S1: S1–S9 state vectors (chain order) | planned |
| C-011 | Applying records | MUST | A consumer that follows non-final blocks MUST therefore recompute state when a reorganization removes blocks; alternatively it can follow only finalized blocks. | S1: S4 reorganization vector; S4: `list --finalized` follows finalized blocks only | planned |
| C-012 | Applying records | MUST | A replaced value MUST NOT be presented as current or used as a fallback; consumers MAY keep it as clearly marked history. | S1: latest-value-wins state vectors | planned |
| C-013 | Applying records | MUST | The consumer MUST hide the identity, clear all its fields, and stop serving its earlier values as metadata or metadata history. | S1: tombstone state vectors | planned |
| C-014 | Common fields | SHOULD | For each token identity it describes, a contract SHOULD publish the three common keys `name`, `symbol` and `decimals`, and MAY publish the optional key `standards`. | S2/S3: every example publishes `name`, `symbol`, `decimals` | planned |
| C-015 | Common fields | SHOULD | \| `name` \| UTF-8 string (1), not empty \| SHOULD \| Display name. \| | S1: usability vectors (empty or non-string `name` is unusable); S2/S3 emit valid values | planned |
| C-016 | Common fields | SHOULD | \| `symbol` \| UTF-8 string (1), not empty \| SHOULD \| Ticker. \| | S1: usability vectors (`symbol`); S2/S3 emit valid values | planned |
| C-017 | Common fields | SHOULD | \| `decimals` \| unsigned integer (2) \| SHOULD \| Number of decimal places: 10^`decimals` base units make one whole token, so a raw amount is shown as `amount / 10^decimals`. Emitters SHOULD use `Uint<8>`, the type MIP-0011 and MIP-0014 use. \| | S1: usability vectors (`decimals`); S2/S3 emit `Uint<8>` | planned |
| C-018 | Common fields | SHOULD | A token that also exposes MIP-0004, MIP-0011 or MIP-0014 getters SHOULD emit the same values those getters return. | Not testable here: consumers cannot execute getters today (owner ruling); examples use the same literals | not testable here |
| C-019 | Common fields | MUST | A field whose current value lacks the type or form above is **unusable**: consumers show no value for it and MUST NOT fall back to an earlier value. | S1: unusable-field vectors (no fallback) | planned |
| C-020 | Common fields | MUST | Consumers MUST NOT assume a default, such as 0 or 18 decimals. | S1: never-set field vectors (no default) | planned |
| C-021 | Common fields | SHOULD | A token may also claim standards from elsewhere, such as BIPs or ERCs; their identifiers and what they mean on Midnight SHOULD be defined in a MIP. | Not testable here: a requirement on future MIPs | not testable here |
| C-022 | Common fields | MUST | A consumer MAY use an identifier it recognizes to choose a UI or adapter it already trusts, but MUST NOT treat it as proof of conformance and MUST NOT fetch or run code because of it. | S1: consumer has no network or code-loading path; `standards` parsed as data only | planned |
| C-023 | Symbol grouping | SHOULD | Indexers SHOULD group visible token identities that share `(network, contractAddress)` and have the same usable `symbol`, compared as exact bytes. | S1: S8/S9 grouping vectors; S3: multi-kind example | planned |
| C-024 | Publishing | MUST | **No events in normal operation.** Normal token operation, such as mints, transfers and burns, MUST NOT emit metadata events. | S2/S3: mint/transfer/burn tests capture no `Misc` event | planned |
| C-025 | Publishing | SHOULD | Anyone who can call it can rename or withdraw the token, so it SHOULD be access-controlled or publish-once. | S0: create-and-destroy (VerifierKeyRemove) proven on the local stack and Stagenet; S2/S3: non-owner call rejected | partial (S0) |
| C-026 | Publishing | SHOULD | Records for one token identity MAY be emitted in different events, but SHOULD be grouped into as few events as the size limit allows ([Limitations](#limitations)). | S2/S3: examples publish all records of an identity in one event; A2 capacity vector | planned |
| C-027 | Consuming | MUST | Consumers MUST bounds-check every length before slicing and MUST harden their UTF-8, JSON and URI parsers. | S1: R-vectors with out-of-range lengths; strict UTF-8/JSON/URI parsers | planned |
| C-028 | Consuming | MUST | Consumers MUST NOT fetch a URI from a value without the precautions they apply to any remote content. | S1: consumer never fetches (no network code in codec/consumer) | planned |
| C-029 | Off-chain content | SHOULD | If off-chain content is used, the MIP that defines it SHOULD include a way to validate that content, such as a URL together with a hash of the content. | Not testable here: a requirement on future MIPs | not testable here |
| C-030 | Security Considerations | MUST/SHOULD | Consumers MUST keep each claim attached to its token identity and SHOULD make that identity visible to users. | S4: `list`/`verify` output always carries `(network, contractAddress, domainSep, kind)`; consumer guide | planned |
| C-031 | Security Considerations | SHOULD | They SHOULD require a curation signal (allowlist, registry attestation or user confirmation) before presenting a token as a known asset. | Not testable here: wallet/explorer UI policy; documented in the consumer guide | not testable here |
| C-032 | Security Considerations | MUST | Consumers MUST NOT treat tokens from different contracts as the same asset because their `symbol` values match, and membership of a group within one contract does not prove its members are interchangeable. | S1: grouping vector with two contracts and one symbol (never grouped) | planned |
