# Proposed MIP notes from the Stagenet cases (staging file)

Staged by the Stagenet runner (S5/S6b) for the orchestrator to merge into the root
[`MIP-PROPOSAL-NOTES.md`](../../MIP-PROPOSAL-NOTES.md) under the next free numbers, then delete this file. Evidence that
existing notes were waiting for (N2, N3, N4, N5, N8, N10) was linked into those notes directly.

## S5-a — Spam and cost: give issuers the order of magnitude of a metadata transaction

- **MIP section**: Security Considerations — "Spam and cost" ("Events pay the existing `Log` fee and compete for each
  block's `bytes_written` budget").
- **Problem**: the sentence names the fee mechanism but not its size, so an issuer cannot tell whether publishing,
  renaming or withdrawing is cheap enough to do routinely, and a reviewer cannot judge the spam bound. Two facts are
  not obvious: the fee of a metadata transaction hardly depends on the emitting circuit's size, and most of an
  issuer's cost is at deployment (one verifier key per circuit).
- **Evidence** (Stagenet, ledger 9.1.0.0-rc.3, 2026-10-02; receipts in each case's `record.json`, table in
  [`docs/costs.md`](../../docs/costs.md#fees-on-stagenet)): every transaction emitting one MIP-0018 event cost
  0.169–0.179 DUST whatever its circuit (k = 6 literal A1 … k = 16 raw emitter; full 256-byte payloads and short ones
  alike — the 34 single-event transactions of C01–C10 plus S0-SPIKE); one call emitting three events 0.193 DUST (C04); two events 0.181 (C08); a tombstone
  0.174 (C06). Deploying the tokens cost 1.5 DUST (1 circuit) to 7.0 DUST (10 circuits, OpenZeppelin), i.e.
  ≈ 0.6–0.9 DUST per additional verifier key; adding one later with a `VerifierKeyInsert` 0.911 DUST (U1); a
  `VerifierKeyRemove` 0.039 DUST.
- **Proposed text** (informative, after the Spam-and-cost sentence): "For orientation: on Midnight Stagenet
  (ledger 9.1) a transaction that emits one metadata event cost about 0.17 DUST in 2026, largely independent of the
  emitting circuit's size or the payload's length; each emitting circuit adds its verifier key to the contract's
  deployment cost."
- **Meanwhile**: `docs/costs.md` publishes the measured figures (local and Stagenet) with the circuit sizes.
- **Status**: PROPOSED (informative; figures are network- and time-dependent, so the authors may prefer to link a
  measurement instead of quoting numbers)
