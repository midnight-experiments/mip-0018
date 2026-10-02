# Proposed additions to `MIP-PROPOSAL-NOTES.md` (from S1 — vectors, codec, consumer)

For the orchestrator: append these sections to the repository root `MIP-PROPOSAL-NOTES.md` (after N4) and delete this
file in the merge. Same format as N1–N4; MIP text = `b147c627e1bb15b5d15cc73cf30c2a36afd34dbb`.

---

## N5 — `standards`: say that the identifier rule is a byte rule (other Unicode spaces and controls are allowed)

- **MIP section**: Common fields — `standards` ("An identifier is non-empty and contains no spaces or control characters (no byte in `0x00`–`0x20` or `0x7f`).").
- **Problem**: the words "spaces or control characters" read like Unicode categories, while the parenthesis defines a byte rule. They differ for valid UTF-8 identifiers that contain, for example, U+00A0 (no-break space, bytes `c2 a0`) or U+0085 (C1 control NEL, bytes `c2 85`): no byte is in `0x00`–`0x20`/`0x7f`, so the byte rule accepts them, but a consumer that checks Unicode whitespace/control categories marks the whole field unusable. A malformed `standards` is unusable, not empty, so the two consumers then disagree on which standards a token claims.
- **Evidence**: informative vectors `vectors/informative/state/INF-STD-6.json` (U+00A0) and `INF-STD-7.json` (U+0085), both usable under the byte rule; the reference consumer implements the byte rule.
- **Proposed text**: "An identifier is non-empty and contains no byte in `0x00`–`0x20` or `0x7f` (ASCII space and control characters). Other characters, including non-ASCII spaces and controls, are allowed; identifiers SHOULD use printable ASCII."
- **Meanwhile**: the reference consumer applies the byte rule exactly as the parenthesis states; the two vectors are informative.
- **Status**: PROPOSED (editorial)

## N6 — Testing: say which consumers S8 (display) and S9 (symbol grouping) apply to

- **MIP section**: Testing ("These vectors are normative") and Path to Active ("At least two independent consumers … pass every vector"), versus Common fields (`decimals` meaning: "a raw amount is shown as `amount / 10^decimals`") and Symbol grouping ("Indexers SHOULD group …").
- **Problem**: S9 tests a SHOULD (grouping) and S8 tests presentation. A conforming consumer that does not group symbols (allowed by "SHOULD") or does not display amounts (for example an indexer that only serves raw fields) cannot "pass every vector", although it breaks no MUST. Whether such a consumer counts towards the acceptance criterion is unclear.
- **Evidence**: this repository's runner reports S8 and S9 like every other normative vector (`vectors/state/S8.json`, `S9a`–`S9d`); a consumer without grouping fails S9a–S9d only.
- **Proposed text** (Testing, before the state rules): "S8 applies to consumers that display amounts and S9 to consumers that group symbols; a consumer that does neither passes the other vectors."
- **Meanwhile**: the vectors keep S8 and S9 normative as the MIP says; the runner's per-test-id summary lets a consumer show exactly which of these it does not implement.
- **Status**: PROPOSED (editorial)
