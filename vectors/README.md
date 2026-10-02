# MIP-0018 test vectors

Language-neutral fixtures for every normative test of **MIP-0018 On-Chain Token Metadata Emission**, plus informative
extras, a JSON Schema for each format, an independent generator and a runner any consumer can implement.

| | |
|---|---|
| MIP text | [`midnightntwrk/midnight-improvement-proposals@b147c627e1bb15b5d15cc73cf30c2a36afd34dbb` `mips/mip-0018-on-chain-token-metadata.md`](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/b147c627e1bb15b5d15cc73cf30c2a36afd34dbb/mips/mip-0018-on-chain-token-metadata.md), SHA-256 `9ffba7e6a3123cd6683e5a779ac3b73c8a31a9724367cd98ee120be78720d842`, under review in [PR #340](https://github.com/midnightntwrk/midnight-improvement-proposals/pull/340) |
| Event name | `pad(32, "mip-0018:token-metadata[v1]")` = `6d69702d303031383a746f6b656e2d6d657461646174615b76315d0000000000` |
| Vectors | **67 normative** (40 payload, 27 state) and **34 informative** (26 payload, 8 state) — `manifest.json` lists every one |
| Integrity | `SHA256SUMS` covers every fixture, schema and the manifest (`cd vectors && sha256sum -c SHA256SUMS`) |

The MIP text is the authority. Where this folder had to choose something the MIP does not determine, the choice is
labelled informative and, if it should be settled upstream, recorded as a note in `MIP-PROPOSAL-NOTES.md`.

## Layout

| Path | Content |
|---|---|
| `payload/<id>.json` + `<id>.bin` | Normative payload vectors (A1–A5, R1–R6, the ignore rule): one observed event and the expected classify/decode result. `.bin` holds the same 256 payload bytes |
| `state/<id>.json` | Normative state vectors (S1–S9, plus state companions of A3–A5): a sequence of observed events in chain order and the state that must result |
| `informative/uri/` | The 26 URI cases with the RFC 3986 `URI` verdict (owner ruling Q20 = ERC-721's rule, note N1) and the investigation data; see its README |
| `informative/state/` | `standards` list format and common-field forms derived from the MIP text but not in its Testing list (`INF-STD-6/7` illustrate note N5) |
| `schema/` | JSON Schemas (2020-12): `payload.schema.json`, `state.schema.json`, `runner.schema.json` (protocol), `manifest.schema.json` |
| `manifest.json` | MIP pin, event name, counts, and every vector with its MIP test id and normative flag |
| `tools/generate.ts` | The generator (`--check` mode for CI) |
| `tools/run.ts` | The runner (`--consumer "<cmd>"`) |
| `tools/validate.ts` | Schema validation of every file |

## Test id → vectors

| MIP test | Normative vectors |
|---|---|
| A1 Common fields and `standards` (= Appendix A) | `payload/A1` |
| A2 Capacity | `payload/A2a` (220-byte key, empty value), `A2b` (1-byte key, 219-byte value) |
| A3 Exact bytes | `payload/A3a` (`symbol` vs `symbol\0`), `A3b` (`01 00 00` keeps trailing zeros), `A3c` (non-UTF-8 key); `state/A3a-state` (two fields) |
| A4 Integer widths | `payload/A4a` (`Uint<8>`), `A4b` (`Uint<128>`); `state/A4b-state` |
| A5 Non-tombstones | `payload/A5a` (empty string), `A5b` (empty bytes), `A5c` (JSON `null`); `state/A5a-state`, `A5b-state`, `A5c-state` |
| R1 Header only | `payload/R1` |
| R2 Past byte 256 | `payload/R2a` (221-byte key: length byte past the end), `R2b` (1-byte key + 220-byte value), `R2c` (key ends at 256: no type byte), `R2d` (after a valid record: no length byte), `R2e` (`keyLen` at byte 255), `R2f` (`keyLen` 255) |
| R3 Non-zero after a zero `keyLen` | `payload/R3a` (next byte), `R3b` (last byte) |
| R4 `kind` / `valType` | `payload/R4a` (kind 0), `R4b` (4), `R4c` (255), `R4d` (valType 6), `R4e` (255) |
| R5 Value rules | `payload/R5a` (invalid UTF-8, type 1), `R5b` (type 3), `R5c` (type 4), `R5d` (invalid JSON), `R5e` (relative URI), `R5f` (0-byte integer), `R5g` (32-byte integer), `R5h` (Null with `valLen` 1) |
| R6 Valid then invalid | `payload/R6a` (valid record, then invalid), `R6b` (tombstone, then invalid) |
| Must ignore | `payload/I1a` (`[v2]` name, valid payload), `I1b` (`[v2]` name, payload invalid under v1), `I2a` (other name), `I2b` (v1 text, non-zero padding byte), `I3` (other event type) |
| S1 Order within an event | `state/S1a` (with the Null at `retire`, offsets 33/41/50), `S1b` (without) |
| S2 Latest value wins | `state/S2a` (four events, then `Beta`), `S2b` (one event, then `Beta`) |
| S3 Tombstone | `state/S3a` (kind 1 withdrawn, kind 3 unchanged), `S3b` (repeated tombstone), `S3c` (revive with only `name`), `S3d` (Null at key `name`) |
| S4 Reorganization | `state/S4a` (tombstone block removed → restored), `S4b` (re-added → withdrawn) |
| S5 Unusable fields | `state/S5a` (empty `name`), `S5b` (type-1 `decimals`), `S5c` (`standards` with two spaces) |
| S6 Separate identities | `state/S6a` (kinds 1/2/3, no color for 3), `S6b` (two contracts) |
| S7 Independent events | `state/S7a` (malformed event first), `S7b` (malformed event second) |
| S8 Display | `state/S8` |
| S9 Symbol grouping | `state/S9a` (membership), `S9b` (rename), `S9c` (symbol change moves one member), `S9d` (tombstone removes a member) |

Sub-cases beyond the MIP's literal examples (R2c–R2f, R3b, I1b, I2b, S7b, the state companions) apply the same MIP
sentence to another position or order; none adds a rule.

Unless a vector says otherwise: `domainSep = 0x11 × 32`, `kind = 3`, network `testnet-a`, contract
`aa…aa` (32 bytes); a second contract is `bb…bb` and a second network `testnet-b`.

## Formats

All bytes are lowercase hex. Integers that can exceed 2^53 (decoded `valType` 2 values, raw amounts, `decimals`) are
decimal strings. Schemas: `schema/*.schema.json`.

**Payload vector** — `{id, mip:{commit, testId}, normative, description, basis?, event:{type, name_hex, payload_hex, payload_file}, expect}` where `expect` is one of

- `{result:"accept", header:{domainSep, kind}, records:[{offset, key_hex, valType, value_hex, decoded?}], contentEnd}`
  — `offset` is the record's `keyLen` byte; `decoded` (type 2 only) is the integer; `contentEnd` is the offset right
  after the last record; `key_text`/`value_text` are readability annotations, never compared;
- `{result:"reject", reason, offset}` — the whole event is rejected and none of its records applies;
- `{result:"ignore", reason}` — not a MIP-0018 v1 event (other type or other name).

Only `result`, `header`, `records` (with `decoded`) and `contentEnd` are normative. `reason` and `offset` are
repository-defined and informative:

| `reason` | Check |
|---|---|
| `bad-payload-length` | payload is not 256 bytes |
| `bad-kind` | byte 32 is not 1, 2 or 3 (`offset` 32) |
| `no-records` | no record before the zero padding (`offset` 33) |
| `nonzero-padding` | a non-zero byte after a zero `keyLen` (`offset` = that byte) |
| `key-out-of-bounds`, `valtype-out-of-bounds`, `vallen-out-of-bounds`, `value-out-of-bounds` | that part of the record would extend past byte 256 (`offset` = the record) |
| `reserved-valtype` | `valType` 6–255 |
| `invalid-utf8`, `invalid-json`, `invalid-uri`, `bad-integer-length`, `bad-null-length` | the value breaks its type's rule (`offset` = the record) |
| `not-misc`, `other-name` | ignore reasons |

**State vector** — `{id, mip, normative, description, steps, expect}`:

- `steps[]` is `{op:"apply", network, block, tx, event, contractAddress, type, name_hex, payload_hex}` — one observed
  event; `contractAddress` is the address the event is bound to (from the event record, never from the payload) — or
  `{op:"rollback", network, toBlock}` — a reorganization that removes every block above `toBlock` on that network.
  Steps are in chain order per network: `(block, tx, event)` strictly increasing; after a rollback the next event is
  above `toBlock`.
- `expect.identities[]` is `{network, contractAddress, domainSep, kind, visible, colored?, fields:{<key_hex>:{valType, value_hex, usable?}}}`;
  `usable` is given for the four common keys (`name`, `symbol`, `decimals`, `standards`); `colored` says whether a
  color `tokenType(domainSep, contractAddress)` is derived (kinds 1 and 2 only).
- `expect.groups[]` (S9 only) is `{network, contractAddress, symbol_hex, members:[{domainSep, kind}]}`: every visible
  identity with a usable `symbol` is in exactly one group of its `(network, contractAddress)` and exact symbol bytes
  (single-member groups included).
- `expect.display[]` is `{network, contractAddress, domainSep, kind, raw, decimals, text}`: `raw` displayed with that
  identity's current usable `decimals`.

## Runner contract

A consumer in any language is tested by a small adapter program:

1. The runner starts `<consumer-cmd>` once (`sh -c`), writes **one JSON request per line** to its stdin and reads
   **exactly one JSON response per line** from its stdout, in the same order. Anything on stderr is passed through.
2. Requests (`schema/runner.schema.json#/$defs/request`):
   - `{"id", "op":"decode", "type", "name_hex", "payload_hex"}` → classify and decode one event; respond
     `{"id", "result", "reason"?, "offset"?, "header"?, "records"?, "contentEnd"?}` with the payload-vector `expect` shape.
   - `{"id", "op":"state", "steps":[…], "display"?:[{network, contractAddress, domainSep, kind, raw}]}` → start from an
     empty state, apply the steps, and respond `{"id", "identities":[…], "groups":[…], "display":[…]}` with the
     state-vector `expect` shape. Report every identity you track; a hidden identity without fields may be omitted.
   - Respond `{"id", "error":"…"}` if a request cannot be processed (the vector fails).
3. Comparison: only properties present in `expect` are compared; hex is compared case-insensitively; `reason` and
   `offset` differences are notes (`--notes`), never failures; a hidden identity without fields equals an absent one;
   any missing or extra identity, field or group fails; `usable` is compared where expected.
4. The runner prints PASS/FAIL per vector and a per-test-id summary, and exits **0** when every normative vector passes,
   **1** when any normative vector fails, **2** on usage, integrity (`SHA256SUMS`) or harness errors. Informative
   failures are reported but do not change the exit status.

Run it (Node ≥ 24; from the repository root):

```sh
node vectors/tools/run.ts --consumer "node packages/consumer/bin/vector-adapter.js"
node vectors/tools/run.ts --consumer "./my-wallet-adapter" --normative-only --notes --json report.json
node vectors/tools/run.ts --consumer "…" --only S3,S4a   # by MIP test id or vector id
```

The reference adapter is `packages/consumer/bin/vector-adapter.js`; it is about 100 lines and a template for other
languages.

## Generating and checking

`tools/generate.ts` writes every fixture, `manifest.json` and `SHA256SUMS`; `--check` regenerates in memory and fails
on any difference or stale file (run in CI). It is an **independent oracle**: payloads are built by explicit byte
arithmetic and every expected result is written by hand — no decoder, no reducer, nothing imported from
`packages/codec` or `packages/consumer`. It also checks A1 against a literal transcription of the MIP's Appendix A,
the MIP's stated offsets (A1: 33/50/63/75/95; S1: 33/41/50) and the URI verdicts against the two independent grammars
of the investigation.

```sh
node vectors/tools/generate.ts --check
node vectors/tools/validate.ts
```

## Informative vectors and repository conventions

- **URI (`valType` 4)** — `informative/uri/`: RFC 3986 `URI` as ERC-721 uses it (scheme required, fragment allowed,
  ASCII only); 16 accept, 10 reject. Note N1 proposes this wording upstream.
- **`standards` and common fields** — `informative/state/`: trailing/leading spaces and tabs are malformed (unusable),
  an empty value claims nothing (usable), duplicates are allowed; wrong types/forms of `name`, `symbol`, `decimals`
  are unusable. `INF-STD-6/7`: identifiers containing U+00A0 or U+0085 are usable under the MIP's byte rule ("no byte
  in 0x00–0x20 or 0x7f"); note N5 asks the MIP to say so explicitly.
- **JSON (`valType` 3)** — no informative vectors: each consumer uses its platform's JSON parser on the strictly decoded
  UTF-8 text (owner ruling).
- **Display formatting** beyond S8 (trailing zeros, very large `decimals`) is a presentation choice of each consumer
  and is not part of the vectors.
