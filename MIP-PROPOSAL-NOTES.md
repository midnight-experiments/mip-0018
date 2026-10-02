# MIP-0018 proposal notes

Things this reference implementation found that should be **defined or updated upstream** in MIP-0018.
They are notes for the MIP authors, not changes made here: the MIP text stays the authority, and every behaviour in this repository follows the pinned text below until a note is accepted upstream.

| | |
|---|---|
| MIP text these notes refer to | [`midnightntwrk/midnight-improvement-proposals@b147c627e1bb15b5d15cc73cf30c2a36afd34dbb` `mips/mip-0018-on-chain-token-metadata.md`](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/b147c627e1bb15b5d15cc73cf30c2a36afd34dbb/mips/mip-0018-on-chain-token-metadata.md) (SHA-256 `9ffba7e6a3123cd6683e5a779ac3b73c8a31a9724367cd98ee120be78720d842`) |
| How to add a note | One section per note: MIP section, problem, evidence, proposed change, what this repository does meanwhile, status. Append; never delete — change the status instead. |
| Statuses | `NEEDS-DECISION` (options below, the authors choose) · `PROPOSED` (concrete text suggested) · `ACCEPTED-UPSTREAM` (merged into the MIP; link the commit) · `WITHDRAWN` |

---

## N1 — Define a valid URI (`valType` 4) the way ERC-721 does: RFC 3986 `URI`

- **MIP section**: Value types (`valType` 4: "A UTF-8 absolute URI (RFC 3986)").
- **Problem**: the sentence admits several readings. RFC 3986 `absolute-URI` has no fragment while `URI` does; RFC 3986 is ASCII-only while the MIP says UTF-8 (which suggests RFC 3987 IRIs). Because a value that breaks its type's rule rejects the **whole event**, two consumers that read it differently disagree on every record of that event.
- **Evidence**: 26 realistic values checked against 9 validators (WHATWG `URL`, fast-uri, uri-js, Python `urllib.parse`, `rfc3986`, `rfc3987`, a strict RFC 3986 grammar). 15 values get the same verdict everywhere; 11 split the libraries: a fragment (under the `absolute-URI` reading), non-ASCII host/path/query, a space, a backslash, an empty authority, an out-of-range port, a leading space, a bad percent-escape. Two independent strict-grammar validators agree on all 26. Data and harnesses: `vectors/informative/uri/` (added with the vectors).
- **Decision for this repository**: follow ERC-721, whose `tokenURI` says "URIs are defined in RFC 3986" — i.e. the RFC 3986 `URI` rule: a scheme is required, a fragment is allowed, characters are ASCII (non-ASCII characters percent-encoded, host names in their ASCII form). Relative references are rejected (as vector R5 already requires).
- **Proposed text**: "| 4 | URI | A URI as defined in RFC 3986 (the `URI` rule of §3, as used by ERC-721 `tokenURI`): a scheme is required and a fragment is allowed. All characters are ASCII; characters outside ASCII MUST be percent-encoded, and host names converted to their ASCII form, before emitting. |"
- **Alternatives considered**: RFC 3987 IRI (matches "UTF-8" but few validators); keep `absolute-URI` (rejects fragments every library accepts); "parses as a WHATWG URL" (lenient and normalising, disagrees with RFC libraries); a minimal "scheme + no space/control bytes" rule (simple, but accepts strings no parser accepts).
- **Meanwhile**: the reference consumer enforces the RFC 3986 `URI` rule with a strict grammar; the 26 cases are informative vectors with that verdict.
- **Status**: PROPOSED

## N2 — Say that raw ledger log data has its trailing zero bytes removed

- **MIP section**: Payload ("every byte after the last record, up to byte 256, is zero") and Consuming ("How consumers obtain events is defined by MIP-0002").
- **Problem**: the ledger and the Compact runtime store a logged `Misc` item (`name ‖ payload`, 288 bytes) **without its trailing zero bytes**. A consumer that reads events from raw transactions, node data or the runtime (instead of the indexer, whose `payload` is already 256 bytes) sees a shorter byte string and may reject a valid payload as truncated, or mis-split `name` and `payload`.
- **Evidence**: ledger source (log items are stored without trailing zeros) and the Compact runtime (`CircuitResults.context.events` returns the shortened data); the indexer's `MiscContractEvent.payload` is padded to 256. Confirmed on Stagenet case S0-SPIKE (`deployments/stagenet/`, record `test-contracts/toolchain-spike/records/stagenet.json`, event id 53254): the event's `raw` ledger bytes carry only 127 data bytes (the 32-byte name and the 95 content bytes of the A1 payload) followed directly by the next field — the 161 padding zeros are not there — while the indexer's `payload` field is the full 256 bytes.
- **Proposed text** (Consuming, or MIP-0002 if it belongs there): "Some sources return a `Misc` item's 288 data bytes without trailing zero bytes. Consumers MUST zero-extend the data to 288 bytes before taking `name` (bytes 0–31) and `payload` (bytes 32–287)."
- **Meanwhile**: the reference reader zero-extends every raw item to 288 bytes.
- **Status**: PROPOSED

## N3 — State that kinds 1 and 2 share one color under the same `domainSep`

- **MIP section**: Token identity and authority — Lookup.
- **Problem**: the MIP derives both native kinds' color with one formula but never says so explicitly; readers may expect two colors and build a table keyed by color alone.
- **Evidence**: one formula in the Compact standard library (`tokenType`) and in the ledger, with no kind input; to be shown on this repository's own Stagenet case that mints both kinds under one `domainSep` (to be linked from `deployments/stagenet/`).
- **Proposed text** (informative, after "A color held by a user resolves …"): "A shielded and an unshielded mint with the same `domainSep` have the same color; the kind is given by what the user holds (a shielded coin → kind 1, an unshielded UTXO → kind 2), not by the color."
- **Meanwhile**: the lookup table records which kinds were minted under each color.
- **Status**: PROPOSED (editorial)

## N4 — Dependencies: state the toolchain as a minimum

- **MIP section**: Implementation — Dependencies ("Compact 0.34.0 / language 0.26.0 / runtime 0.19.0, Midnight ledger v9").
- **Problem**: read literally it pins one compiler; Compact 0.35.0 (language 0.27.0, runtime 0.20.0, same ledger target) is already released.
- **Proposed text**: "MIP-0002 `Misc` events: Compact 0.34.0 or later (language 0.26.0, runtime 0.19.0 or later), Midnight ledger v9."
- **Evidence**: this repository emits with Compact 0.35.0 (language 0.27.0, runtime 0.20.0) and `--feature-zkir-v3`; the emitted event equals A1 byte-for-byte on the local stack and on Stagenet (case S0-SPIKE).
- **Meanwhile**: the repository states the minimum and the exact versions it is built and tested with (`toolchain.json`).
- **Status**: PROPOSED (editorial)

## N5 — Existing contracts: the inserted verifier key must use the key version of the circuit's proving system

- **MIP section**: Backwards Compatibility Assessment — Existing contracts (step 2: "Add its verifier key with a `VerifierKeyInsert` maintenance update").
- **Problem**: on ledger v9 a contract operation holds verifier keys in two versioned slots: `v3` for circuits compiled to ZKIR v2 (the Compact default) and `v4` for circuits compiled with `--feature-zkir-v3`. A `VerifierKeyInsert`/`VerifierKeyRemove` must name the slot that matches the circuit; a mismatch is included on chain but its fallible segment fails, so the issuer pays a fee and nothing changes. The step reads as if any `VerifierKeyInsert` works, and the current SDK path makes the mismatch easy: midnight-js 5.0.0-rc.2 / compact-js 3.0.0-rc.3 always build `v3` maintenance updates.
- **Evidence**: local stack, this repository's S0 spike: midnight-js `removeVerifierKey()` of a ZKIR-v3 `publishMetadata` → `FailFallible`, key still present; the same `MaintenanceUpdate` with `VerifierKeyRemove(publishMetadata, v4)` → `SucceedEntirely`, key gone; the same `v4` removal on Stagenet (case S0-SPIKE, block 710814). Ledger: `ContractOperationVersion::{V3, V4}`, `ContractOperationVersionedVerifierKey::{V3, V4}`.
- **Proposed text** (informative, after step 2): "The verifier key is inserted at the key version of the circuit's proving system (on ledger v9: `v3` for ZKIR v2 circuits, `v4` for ZKIR v3 circuits). Check that the tool building the maintenance update supports that version."
- **Meanwhile**: the upgrade template (S6) and the create-and-destroy example build the maintenance update with the ledger API and an explicit version (`test-contracts/toolchain-spike/src/lib/maintenance.ts`).
- **Status**: PROPOSED (informative)

## N6 — `standards`: say that the identifier rule is a byte rule (other Unicode spaces and controls are allowed)

- **MIP section**: Common fields — `standards` ("An identifier is non-empty and contains no spaces or control characters (no byte in `0x00`–`0x20` or `0x7f`).").
- **Problem**: the words "spaces or control characters" read like Unicode categories, while the parenthesis defines a byte rule. They differ for valid UTF-8 identifiers that contain, for example, U+00A0 (no-break space, bytes `c2 a0`) or U+0085 (C1 control NEL, bytes `c2 85`): no byte is in `0x00`–`0x20`/`0x7f`, so the byte rule accepts them, but a consumer that checks Unicode whitespace/control categories marks the whole field unusable. A malformed `standards` is unusable, not empty, so the two consumers then disagree on which standards a token claims.
- **Evidence**: informative vectors `vectors/informative/state/INF-STD-6.json` (U+00A0) and `INF-STD-7.json` (U+0085), both usable under the byte rule; the reference consumer implements the byte rule.
- **Proposed text**: "An identifier is non-empty and contains no byte in `0x00`–`0x20` or `0x7f` (ASCII space and control characters). Other characters, including non-ASCII spaces and controls, are allowed; identifiers SHOULD use printable ASCII."
- **Meanwhile**: the reference consumer applies the byte rule exactly as the parenthesis states; the two vectors are informative.
- **Status**: PROPOSED (editorial)

## N7 — Testing: say which consumers S8 (display) and S9 (symbol grouping) apply to

- **MIP section**: Testing ("These vectors are normative") and Path to Active ("At least two independent consumers … pass every vector"), versus Common fields (`decimals` meaning: "a raw amount is shown as `amount / 10^decimals`") and Symbol grouping ("Indexers SHOULD group …").
- **Problem**: S9 tests a SHOULD (grouping) and S8 tests presentation. A conforming consumer that does not group symbols (allowed by "SHOULD") or does not display amounts (for example an indexer that only serves raw fields) cannot "pass every vector", although it breaks no MUST. Whether such a consumer counts towards the acceptance criterion is unclear.
- **Evidence**: this repository's runner reports S8 and S9 like every other normative vector (`vectors/state/S8.json`, `S9a`–`S9d`); a consumer without grouping fails S9a–S9d only.
- **Proposed text** (Testing, before the state rules): "S8 applies to consumers that display amounts and S9 to consumers that group symbols; a consumer that does neither passes the other vectors."
- **Meanwhile**: the vectors keep S8 and S9 normative as the MIP says; the runner's per-test-id summary lets a consumer show exactly which of these it does not implement.
- **Status**: PROPOSED (editorial)

---

## Considered — no change proposed

| Topic | Decision |
|---|---|
| JSON details for `valType` 3 (BOM, surrounding whitespace, duplicate names) | Each consumer uses its own JSON parser; mainstream parsers converge. No change. |
| No upper bound on `decimals` | Not a limit for this MIP; the standards a token follows define good practice. No change. |
| Events from failed transaction segments | Consumers only ever see events the ledger accepted and executed. No change. |
| Getter equality ("SHOULD emit the same values those getters return") cannot be checked today | Enforceable once contract getters can be executed by consumers. No change. |
| Color lookup needs mint data the public indexer does not expose | The MIP already assigns this to indexers; this repository ships a reference scanner that builds the color table from a start block. No change. |
