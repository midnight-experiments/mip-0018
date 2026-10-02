# Proposed MIP-0018 notes from S2 (Compact module)

Staging file for the orchestrator: move these into the root `MIP-PROPOSAL-NOTES.md` as the next note
numbers (N8, N9, …; numbers are assigned at merge because other slices propose notes too), then delete
this file. Same format as the root file; MIP text = `midnightntwrk/midnight-improvement-proposals@b147c627`.

---

## Nx (S2-a) — Publishing: name "removed after use" as a third way to protect an emitting circuit

- **MIP section**: Publishing ("Who may call an emitting circuit is the contract's choice. Anyone who can call it can rename or withdraw the token, so it SHOULD be access-controlled or publish-once.").
- **Problem**: Midnight offers a third protection that needs no guard in the circuit: the contract's maintenance authority removes the emitting circuit's verifier key (`VerifierKeyRemove`) right after the deployer's first call, so nobody can call it again. It is cheaper than an owner check and simpler than a publish-once flag, and the owner of this reference chose it for the minimal example. It is only safe when the circuit's payload is **constant**: until the key is removed, anyone holding the compiled artefacts can call the circuit, and with runtime parameters they could publish anything (with a constant payload they can only re-emit the same values). The MIP's sentence does not mention it, and does not warn that an unguarded circuit with parameters is unsafe even briefly.
- **Evidence**: `examples/minimal/contracts/CreateAndDestroy.compact` — runtime tests (`examples/minimal/test/minimal.test.ts`: any caller re-emits exactly the A1 bytes before removal) and an end-to-end run on the local chain (`examples/minimal/scripts/create-and-destroy.ts`, 2026-10-01: deploy → `publishMetadata()` → one `Misc` event = A1 → `VerifierKeyRemove(publishMetadata, v4)` `SucceedEntirely` → a second call is refused, `Operation 'publishMetadata' is undefined`, still one event; `transfer` keeps its key). Stagenet: case S0-SPIKE (removal in block 710814). The deployed operation holds only the verifier key (1,353-byte key → 1,362-byte operation), not the circuit's ZKIR, so callers need the artefacts — which DApps ship. The removal must use the `v4` key slot for ZKIR v3 circuits (root note N5).
- **Proposed text** (Publishing, replacing the third bullet): "Who may call an emitting circuit is the contract's choice. Anyone who can call it can rename or withdraw the token, so it SHOULD be access-controlled, publish-once, or removed after use (for example, a `publishMetadata()` whose payload is constant, whose verifier key the maintenance authority removes right after the deployer's call). An emitting circuit that is not access-controlled SHOULD NOT take the metadata as parameters."
- **Meanwhile**: `packages/compact/README.md` documents the three patterns with these caveats; `examples/minimal` implements all three.
- **Status**: PROPOSED

## Nx (S2-b) — Payload: do not tie the Compact construction to `serialize` of non-event types

- **MIP section**: Payload ("Compact has no runtime-sized byte strings, so a Compact emitter builds each payload from fixed-size fields (for example `Uint<8>` lengths and `Bytes<K>` keys), using the serialization the Compact compiler provides for those types.").
- **Problem**: the natural reading is `serialize<[header, records…], 256>(…)`. Compact 0.34.0 and 0.35.0 accept that for tuples and structs, but their standard-library documentation says `serialize` "can only be instantiated for an event type and its canonical serialized size" (`doc/api/CompactStandardLibrary/exports.md`, tag `compactc-v0.35.0`). If a later compiler enforces its documentation, the MIP's suggested method stops compiling. The same bytes can be built without `serialize`, by concatenating fixed-size fields with `Bytes[...]` spreads and a zero tail; both are checked at compile time.
- **Evidence**: `packages/compact` builds the payload both ways (`Mip0018.compact` with `serialize`, `Mip0018Pure.compact` with spreads). Executed in compact-runtime 0.20.0 they emit identical bytes, equal to the vectors A1–A5 and S1 and to the reference encoder for 729 generated payloads (every value size 1–219, multi-record shapes; `test/equivalence.test.ts`). Size errors are compile errors in both (`test/compile-fail.test.ts`). Cost: identical for constant payloads (k = 6); with runtime values `serialize` is cheaper (25,857 vs 39,207 rows for the four common fields, `docs/costs.md`).
- **Proposed text**: "… so a Compact emitter builds each payload from fixed-size fields (for example `Uint<8>` lengths and `Bytes<K>` keys), concatenated in order and zero-padded to 256 bytes — for example with the serialization the Compact compiler provides for those types, or with byte-vector concatenation — so that every length is checked at compile time."
- **Meanwhile**: the default module uses `serialize` (owner decision Q3: "ideally we can serialize with Compact"); the pure-circuit module is the fallback, and a compile test would catch a compiler that restricts `serialize`.
- **Status**: PROPOSED (informative)

---

## Considered — no change proposed (add to the root table)

| Topic | Decision |
|---|---|
| Circuit cost of emitting (S2 measurements: a constant payload costs only the `emit`, k = 6 / 48 rows; any runtime byte, even a `domainSep` read from the ledger, k = 14 / ≈ 14,000 rows; four runtime common fields k = 15) | Implementation guidance, not protocol: documented in `docs/costs.md` and the module README. No change. |
| An empty key (`keyLen` 0) is a valid Compact generic size (`Bytes<0>`) | Emitter-library concern: the reference module makes it a compile error (`slice<1>(key, 0)` guard). The MIP's "1–255" stands. No change. |
