# Proposed MIP-0018 notes from S4 (scripts and the mint scanner)

For the orchestrator to merge into the repository's `MIP-PROPOSAL-NOTES.md` (next free numbers), in that file's
format. The pinned MIP text stays the authority; the code in `packages/midnight` follows it as written.

---

## S4-a — Lookup: count only mints that took effect, read from the transaction's effects

- **MIP section**: Token identity and authority → Lookup ("indexers record the contract address and `domainSep` of
  every mint in each block, compute `color = tokenType(domainSep, contractAddress)` …").
- **Problem**: "every mint in each block" does not say where a mint is read from or which mints count. A raw
  transaction carries each contract call's declared effects (`shieldedMints` / `unshieldedMints`: `domainSep →
  amount`) in BOTH its guaranteed and its fallible transcript, and the bytes are on chain even when the fallible
  segment failed or the whole transaction failed — those mints never happened. Two other tempting sources are wrong
  for the table: MIP-0002 `ShieldedMint` / `UnshieldedMint` events are emitted by the contract (any values, or none
  at all), and an unshielded UTXO's `tokenType` is the color but does not name the minting contract.
- **Evidence**: `packages/midnight/src/raw.ts` / `scanner.ts` (S4): decoding with ledger-v9 1.0.0-rc.5 shows the
  effects per transcript; the indexer's `transactionResult { status segments { id success } }` tells which parts were
  applied (midnight-ledger `semantics.rs`: guaranteed part applies unless the transaction fails; a fallible segment's
  effects apply only if that segment succeeds). Recorded Stagenet mints (`packages/midnight/test/fixtures/stagenet/
  mint-txs.json`, blocks 508540 / 508544) decode to the color the indexer serves as the UTXO `tokenType`; the local
  end-to-end run checks every mint of the run appears once with the right `(contract, domainSep, kinds)`.
- **Proposed text** (Lookup, informative): "A mint is a `shieldedMints` or `unshieldedMints` effect of a contract
  call in a part of the transaction that was applied: the guaranteed part of a transaction that did not fail, or a
  fallible segment that succeeded. Mint events a contract emits (MIP-0002 `ShieldedMint` / `UnshieldedMint`) and
  UTXO token types are not sources for this table."
- **Meanwhile**: `mip0018 index` counts exactly those mints (`partApplied` in `raw.ts`) and ignores emitted mint
  events.
- **Status**: PROPOSED

## S4-b — "Event within the transaction": name the order a raw-transaction reader must use

- **MIP section**: Applying records ("chain order: block, transaction within the block, event within the
  transaction, then record within the event").
- **Problem**: an indexer gives events in its own id order, but a consumer that reads raw transactions (or a node)
  must order the events of one transaction itself, and a transaction can hold several intents (segments) with
  guaranteed and fallible parts. The MIP does not say what "event within the transaction" means then.
- **Evidence**: midnight-ledger `semantics.rs` applies the guaranteed part of every intent first (intents in
  ascending segment id, actions in intent order, operations in program order), then each fallible segment in
  ascending segment id; the indexer stores events in that order (its ids follow it), and MIP-0002's `EventSource
  { logicalSegment, physicalSegment }` carries the segment. `packages/midnight/src/raw.ts` orders decoded `log`
  operations that way; the local end-to-end run checks that the scanner's per-contract events equal the indexer's,
  byte for byte and in order.
- **Proposed text** (Applying records, informative, or MIP-0002): "Within a transaction, events are in the ledger's
  execution order: the guaranteed part of every intent (in ascending segment id), then each successful fallible
  segment (in ascending segment id); within a part, actions and their operations in order."
- **Meanwhile**: `raw.ts` uses that order; indexer-based commands use the indexer's event id.
- **Status**: PROPOSED
