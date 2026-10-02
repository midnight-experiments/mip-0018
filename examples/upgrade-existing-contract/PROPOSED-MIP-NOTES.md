# Proposed MIP-0018 notes from the upgrade template (S6) — staging file

To be merged into the repository's [`MIP-PROPOSAL-NOTES.md`](../../MIP-PROPOSAL-NOTES.md) as the next
numbers (format there: MIP section, problem, evidence, proposed change, meanwhile, status), then this
file is deleted. Evidence: [`docs/upgrade-guide.md`](../../docs/upgrade-guide.md), this example's tests
and its local run ([`README.md`](README.md#local-run)).

## S6-a — Existing contracts, step 1: say what "against the contract's existing ledger layout" requires, and that nothing on chain checks it

- **MIP section**: Backwards Compatibility Assessment — Existing contracts, step 1 ("Compile a `publishMetadata()` circuit … against the contract's existing ledger layout. It reads the existing `domain` from state and emits it as `domainSep`.").
- **Problem**: Compact assigns ledger state paths by declaration order (the contract's fields and those of imported modules). The new circuit reads the deployed state through the paths of the source it was compiled from; the ledger has no notion of field names or types, so a source with a different layout is accepted on chain and reads other fields. The MIP does not say this, and the failure is silent.
- **Evidence**: `test/upgrade.test.ts` (compact-runtime 0.20.0, one shared state as on chain after the insert): an upgrade source with `domain` and `owner` swapped (both `Bytes<32>`) compiles; its `ledger()` reads other values under the same names; its owner check reads the domain (owner refused); an unguarded variant emits an **accepted** event whose `domainSep` is the owner's id — metadata for an identity nobody holds. `test/layout.test.ts`: the compiler's recorded layout (`compiler/contract-info.json` → `ledger`) detects reorder, rename, retype, other storage, missing/extra fields and imported modules with ledger fields.
- **Proposed text** (step 1, after the first sentence): "The source MUST declare the deployed contract's ledger fields — including those of the modules it imports — exactly as deployed: the same fields, in the same order, with the same types. The ledger does not check this; a different layout makes the circuit read other state, for example a `domainSep` that is not the token's. Compilers record the layout they chose, so tools can compare the two builds before the update is signed."
- **Meanwhile**: `scripts/check-layout.ts` and `mip0018 upgrade` compare the compiled layouts and decode the deployed state through both builds before signing.
- **Status**: PROPOSED

## S6-b — Existing contracts: "does not need redeployment" holds only with a usable maintenance authority

- **MIP section**: Backwards Compatibility Assessment — Existing contracts ("A contract deployed before then has no emitting circuit, but it does not need redeployment: its maintenance authority can add one.").
- **Problem**: a contract's maintenance authority may be frozen: an empty committee (the ledger default), a threshold above the committee size, or keys nobody holds any more. Such a contract can never take a maintenance update, so it cannot add a circuit.
- **Evidence**: ledger 9.1.0.0-rc.3 — `ContractMaintenanceAuthority` default is an empty committee with threshold 1; verification requires `signatures ≥ threshold` from committee keys (`ledger/src/verify.rs`). Local run: an insert signed by a key outside the one-key committee is refused by `mip0018 upgrade` before submission and, forced, rejected by the node with `1010: Invalid Transaction: Custom error: 135` (`MalformedError::InvalidCommitteeSignature`, midnight-node `ledger/src/versions/common/types.rs`), nothing changed (README "Local run"); unit tests of `checkAuthority`.
- **Proposed text**: "… but it does not need redeployment if its maintenance authority can still sign: its maintenance authority can add one. A contract whose authority is frozen (an empty committee, an unreachable threshold, or lost keys) cannot add a circuit and needs a new deployment to adopt this MIP."
- **Meanwhile**: `checkAuthority` refuses frozen authorities, foreign keys and thresholds above 1 before anything is submitted; the upgrade guide lists the check.
- **Status**: PROPOSED

## S6-c — Existing contracts, step 2: inserting never replaces; what an upgrade cannot add

- **MIP section**: Backwards Compatibility Assessment — Existing contracts, steps 1–2; Publishing ("SHOULD be access-controlled or publish-once").
- **Problem**: two practical limits are not stated. (1) `VerifierKeyInsert` never replaces a key already present for that entry point and version (`VerifierKeyAlreadyPresent`), and maintenance updates apply only in a fallible segment, so an insert over an existing `publishMetadata` is included, charged and refused. Changing the circuit takes a `VerifierKeyRemove` first. (2) The deployed state has no room for new ledger fields, so the Publishing section's "publish-once" pattern is impossible for an added circuit; it can reuse the contract's existing access control, or use a constant payload and be removed after the call.
- **Evidence**: local run (README "Local run"): re-inserting the same key and inserting another build's `publishMetadata` key are both refused by `mip0018 upgrade` before submission and, forced, included as `PARTIAL_SUCCESS` (the fallible segment with the update failed; fees ≈ 0.60 DUST each, the same as a successful insert); the key, the authority counter and the ledger data stay unchanged. `test/layout.test.ts`: adding a `published: Boolean` field (a publish-once flag) breaks the layout.
- **Proposed text** (informative, after step 2): "A `VerifierKeyInsert` never replaces an existing key; to change an added circuit, remove its key first. An added circuit cannot add ledger fields, so it cannot be made publish-once; guard it with the contract's existing access control, or give it a constant payload and remove its key after the call."
- **Meanwhile**: the template reuses the token's owner check; `mip0018 upgrade` refuses an insert over another key before submission.
- **Status**: PROPOSED

## S6-d — Security Considerations: the maintenance authority controls the metadata too

- **MIP section**: Security Considerations (Unauthorized updates) and Backwards Compatibility ("the update needs no permission beyond what the issuer already reserved").
- **Problem**: the same authority that adds `publishMetadata()` can remove and insert any circuit at any time, including the emitting circuits and their access checks. For a contract with a live maintenance authority, whoever holds it can rename or withdraw the token regardless of the emitting circuit's guard. Consumers and issuers should know this when they judge who controls a token's metadata.
- **Evidence**: ledger semantics of `VerifierKeyRemove` / `VerifierKeyInsert` (any entry point); the local run inserts a circuit into a deployed token with the deploy-time key alone.
- **Proposed text** (Unauthorized updates, new sentence): "A contract's maintenance authority can replace its emitting circuits, so it can change the metadata as well; metadata is fixed only when no one can call an emitting circuit and no one holds the maintenance authority." (Whether and how an authority can be given up — e.g. a `ReplaceAuthority` to an empty committee — was not exercised here.)
- **Meanwhile**: documented in `docs/upgrade-guide.md` (Limits: Trust).
- **Status**: NEEDS-DECISION (the authors may consider it outside the MIP's scope)

## S6-e — N5 addendum: `VerifierKeyInsert` at `v4` works end to end

- **MIP section**: as N5.
- **Evidence to add to N5**: local run of this template (2026-10-02) — `VerifierKeyInsert(publishMetadata, v4)` of a Compact 0.35.0 `--feature-zkir-v3` circuit into a deployed contract whose original circuit also has a `v4` key: `SUCCESS` (≈ 0.59 DUST), counter 0 → 1, ledger data unchanged; then the call through midnight-js `findDeployedContract` with the upgrade-only build is proven, accepted (≈ 0.16 DUST) and emits the expected event bound to the original address (README "Local run").
- **Status**: evidence for N5 (no new note)

## Considered, no change proposed

- **Pre-v9 (ledger 8) contracts.** The MIP's "a contract deployed before then" includes contracts deployed under ledger 8. Whether such a contract (midnight-js calls them "retained era") accepts a ZKIR-v3 (`v4`) key and the call is not verified here: the local chain and Stagenet run ledger v9 from genesis. No text change proposed without evidence.
