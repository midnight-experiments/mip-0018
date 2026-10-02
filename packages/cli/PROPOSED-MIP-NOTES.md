# Proposed MIP-0018 notes from S4d (staging — the orchestrator moves them into `MIP-PROPOSAL-NOTES.md`)

S4d (CLI adapters for every example, the examples' end-to-end runs on the local chain, the Stagenet case folders,
the walkthroughs) found no new rule that the MIP text must define. What it adds is evidence for existing notes and
two "considered — no change" rows.

## Evidence for existing notes

- **N13 (a fixed-size field must be exactly as long as its value)** — the tooling side now enforces it too: the CLI's
  `{"$utf8": "…"}` argument for a `Bytes<N>` circuit parameter must be exactly N bytes; a shorter text is refused
  ("zero padding would become part of the value") unless `"pad": true` asks for padding on purpose
  (`packages/midnight/src/signer/args.ts`, unit test in `packages/midnight/test/signer-units.test.ts`). Every rename in the
  examples' adapters, the walkthrough and the Stagenet cases goes through this rule.
- **N3 (kinds 1 and 2 share one color)** — on the local chain the multi-kind example's shielded and unshielded mints
  under one `domainSep` resolve, through the mint scanner, to one color entry carrying both kinds
  (`deployments/stagenet/cases/IDX`, steps `lookup-C04-shielded` / `lookup-C04-unshielded`; local run in the S4 plan),
  and the wallet SDK itself lists that one color among both its shielded and its unshielded balances (`wallet status`).
- **N10 (Lookup counts only mints that took effect)** — a published-but-never-minted identity (token-family bronze)
  is colored by the consumer (kind 1) but `lookup` answers "not minted in the scanned range" (exit 3): the color a
  consumer derives and the colors that exist on chain are different sets, as N10 says.

## Considered — no change proposed

| Topic | Why no change |
|---|---|
| An access-control failure leaves no trace on chain | OpenZeppelin `Ownable` (and the minimal owner key) assert inside the circuit, so a non-owner's call fails while the transaction is built: nothing is submitted, paid or emitted (C09, local evidence). Consumers never see such attempts, so the MIP needs no rule about them; the issuer guide says it. |
| Re-publishing identical values or repeating a tombstone | Changes no consumer state (vectors S2/S3b already say so). Whether an issuer's tool skips such a transaction is tooling (Q27: `mip0018 publish` skips it unless `--force`; negative events are never skipped). |
