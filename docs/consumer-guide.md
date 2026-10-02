# Consumer guide — read MIP-0018 token metadata (wallets, explorers, indexers)

How to turn a contract's MIP-0018 events into the name, symbol and decimals a wallet or explorer shows, following the
pinned MIP text ([MIP-0018 @ `78ecbb4b`](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/78ecbb4b1ba57371e84fe45f705991ab7b996a61/mips/mip-0018-on-chain-token-metadata.md)).
The reference implementation of every step is in this repository and passes all normative vectors:

| Step | Reference code | Wallet-free command |
|---|---|---|
| 1. Fetch a contract's events | [`@mip0018/midnight`](../packages/midnight/README.md) (`Indexer`, `listMetadata`) | `mip0018 list` |
| 2–3. Classify, decode, validate | [`@mip0018/codec`](../packages/codec/README.md) (`classifyEvent`, `decodePayload`) | `mip0018 verify` |
| 4–5. Apply, present | [`@mip0018/consumer`](../packages/consumer/README.md) (`MetadataState`, `formatAmount`) | `mip0018 list` |
| 8. Color → token | [`@mip0018/midnight`](../packages/midnight/README.md) (`tokenType`, scanner) | `mip0018 index`, `mip0018 lookup` |
| 9. Test your own consumer | [`vectors/`](../vectors/README.md#runner-contract) (runner contract) | `mip0018 vectors run` |

The commands run in the pinned Docker image ([`packages/cli`](../packages/cli/README.md)):
`docker/run.sh mip0018 -- <command> …`. The issuer side is the [issuer guide](issuer-guide.md); every MUST/SHOULD and
its test is in the [conformance matrix](conformance-matrix.md).

## 1. Fetch the events

MIP-0018 metadata travels in MIP-0002 `Misc` events, bound to the contract that emitted them. The Midnight indexer
(GraphQL v4; Stagenet serves schema 4.4.0-rc.1) returns a contract's events with `contractEvents`, a surface the schema
marks `@beta`:

- Filter `{ contractAddress, types: [MISC] }` (optionally `fromBlock`, `toBlock`, `transactionHash`); `limit` is capped
  at 500. Page with `offset` **until an empty page**: a server that returns fewer rows than asked must not be able to
  truncate the list.
- The indexer ingests **finalized blocks only**, so what it returns is final. If you follow a node yourself, follow
  finalized blocks, or roll back and recompute on a reorganization (step 4).
- `name` is 32 bytes and `payload` 256 bytes, as lowercase hex. **Some sources drop trailing zero bytes** — raw
  ledger log data from a node or a raw transaction always does — and the MIP says (Consuming): "consumers MUST treat
  missing trailing bytes as zero, so that every `name` is 32 bytes and every `payload` 256 bytes, before decoding".
  Zero-extend a short `name` or `payload` (`classifyEvent` and `decodePayload` do it; `zeroExtend` on its own); for
  raw ledger data, which is `name ‖ payload` trimmed as one item, zero-extend it to 288 bytes before splitting
  (`splitMiscData`). A payload longer than 256 bytes is rejected; a name longer than 32 bytes is another name. The
  A1 event of Stagenet case [C10](../deployments/stagenet/cases/C10/README.md) is 127 bytes in the ledger's raw data
  (32 name + 95 content bytes). Informative vectors: `vectors/informative/zero-extension/`.
- Order the events of one transaction as the ledger executes them — the MIP's own rule since `78ecbb4` ("Applying
  records", step 4).
- Completeness (MIP "Consuming"): a verified event does not prove that no later update or tombstone exists. Read every
  event of the contract, not a filtered subset.

A complete minimal consumer — fetch, apply in chain order, present — for the Stagenet case
[C04](../deployments/stagenet/cases/C04/README.md) (one asset as kinds 1, 2 and 3):

```ts
import { fromHex, toHex } from '@mip0018/codec';
import { MetadataState, formatAmount } from '@mip0018/consumer';
import { tokenType } from '@mip0018/midnight'; // ledger-v9 rawTokenType; any equal implementation works

const INDEXER = 'https://indexer.stagenet.shielded.tools/api/v4/graphql';
const CONTRACT = '86acf80ff386abb610aadbea0406039e7fe39893f440794c3c2bad86dd48570f'; // Stagenet case C04

const query = `query ($filter: ContractEventFilter!, $limit: Int!, $offset: Int!) {
  contractEvents(filter: $filter, limit: $limit, offset: $offset) {
    id contractAddress
    ... on MiscContractEvent { name payload }
    transaction { id block { height } }
  } }`;

const events = [];
for (let offset = 0; ; offset += 500) { // page until an EMPTY page: never trust a short page
  const res = await fetch(INDEXER, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables: { filter: { contractAddress: CONTRACT, types: ['MISC'] }, limit: 500, offset } }),
  });
  const { data, errors } = await res.json();
  if (errors) throw new Error(JSON.stringify(errors));
  if (data.contractEvents.length === 0) break;
  events.push(...data.contractEvents);
}

// Chain order: block, transaction, event (the consumer applies the records of an event in order).
events.sort((a, b) => a.transaction.block.height - b.transaction.block.height || a.transaction.id - b.transaction.id || a.id - b.id);

const state = new MetadataState({ tokenType });
for (const e of events) {
  const r = state.apply({
    network: 'stagenet',
    contractAddress: e.contractAddress, // from the event record, never from the payload
    block: e.transaction.block.height,
    tx: e.transaction.id,
    event: e.id,
    type: 'Misc',
    name: fromHex(e.name),
    payload: fromHex(e.payload),
  });
  console.log(`event ${e.id}: ${r.result}${'reason' in r ? ` (${r.reason})` : ''}`);
}

for (const id of state.identities().filter((i) => i.visible)) {
  const color = id.color ? toHex(id.color) : '-';
  const { name, symbol, decimals } = id.common; // usable values only; absent = show nothing
  console.log(`kind ${id.kind} ${name ?? '?'} (${symbol ?? '?'}) decimals ${decimals ?? '-'} color ${color}`);
  if (decimals !== undefined) console.log(`  123456 base units = ${formatAmount(123456n, decimals)} ${symbol ?? ''}`);
}
for (const g of state.groups()) console.log(`group "${new TextDecoder().decode(g.symbol)}": ${g.members.length} identities`);
```

Saved as `consumer-example.ts` at the repository root and run with `docker/run.sh exec 'node consumer-example.ts'`
(2026-10-02):

```text
event 53453: accept
event 53454: accept
event 53455: accept
kind 1 Acme Dollar (ACD) decimals 2 color 042399246139df031a4780c684df8eaecd48b7e03a195bfe986cf22766bcbc16
  123456 base units = 1234.56 ACD
kind 2 Acme Dollar (ACD) decimals 2 color 042399246139df031a4780c684df8eaecd48b7e03a195bfe986cf22766bcbc16
  123456 base units = 1234.56 ACD
kind 3 Acme Dollar (ACD) decimals 2 color -
  123456 base units = 1234.56 ACD
group "ACD": 3 identities
```

The same with the CLI, which also cross-checks the indexer's tip against the node and prints every field, the groups
and the source events ([`examples/verify`](../examples/verify/README.md#2-everything-a-contract-published-list)):

```sh
docker/run.sh mip0018 -- list --network stagenet --contract 86acf80ff386abb610aadbea0406039e7fe39893f440794c3c2bad86dd48570f
```

## 2. Classify: is it a MIP-0018 v1 event?

Consider an event only if its type is `Misc` and its name (zero-extended to 32 bytes, step 1) is exactly the 32 bytes
`pad(32, "mip-0018:token-metadata[v1]")` = `6d69702d303031383a746f6b656e2d6d657461646174615b76315d0000000000`.
**Ignore** everything else — other event types, other names, and other versions such as
`mip-0018:token-metadata[v2]` (never decode a future version with v1 rules). Ignoring is not rejecting: an ignored
event says nothing about the token.

```ts
import { classifyEvent } from '@mip0018/codec';
const c = classifyEvent({ type: 'Misc', name, payload });
// { result: 'accept', header, records, contentEnd } | { result: 'reject', reason, offset } | { result: 'ignore', reason }
```

Vectors: `I1a`, `I1b`, `I2a`, `I2b`, `I3`. On Stagenet: [C07](../deployments/stagenet/cases/C07/README.md) carries
`[v2]` and foreign names next to valid events.

## 3. Decode and validate

The 256-byte payload is a header — `domainSep` (32 bytes) and `kind` (1 byte: 1 shielded, 2 unshielded, 3 ledger) —
then records `keyLen | key | valType | valLen | value` back to back from byte 33, then zero padding. Check it as the
MIP says:

1. `kind` is 1, 2 or 3;
2. read records until byte 256 or a zero `keyLen`; after a zero `keyLen` every remaining byte is zero; every part of a
   record fits in the 256 bytes and its value follows its type's rule;
3. at least one record.

**Any failure rejects the whole event**: apply none of its records, not even the valid ones before the bad one
(vectors `R6a`, `R6b`). Rejecting one event never affects another, even in the same transaction (`S7a`, `S7b`;
Stagenet [C08](../deployments/stagenet/cases/C08/README.md)).

| `valType` | Rule as implemented here |
|---:|---|
| 0 bytes | anything |
| 1 UTF-8 string | strict UTF-8 (no overlongs, surrogates or code points above U+10FFFF); may be empty |
| 2 unsigned integer | 1–31 bytes, little-endian; decode every width to a big integer (`06` and `06` + 15 zero bytes are both 6) |
| 3 JSON | strict UTF-8, then your platform's JSON parser must accept the text as exactly one value (owner ruling F2) |
| 4 URI | strict UTF-8, then the RFC 3986 `URI` rule — the MIP's own text since `78ecbb4` ("a scheme is required, a fragment is allowed, and relative references are not. All characters are ASCII"; from note N1, owner ruling Q20 following ERC-721): `https://acme.example/logo.png#v2` and `ipfs://…` accept; `https://ä.example/`, `https://acme.example/a b.png` and `/relative/path` reject ([26 informative cases](../vectors/informative/uri/README.md)) |
| 5 Null | `valLen` 0 (a tombstone) |
| 6–255 | reserved: reject the event |

Keys are exact bytes: case-sensitive, no trimming or normalisation, zero bytes significant (`symbol` and `symbol\0`
are different keys). A key that is not UTF-8 is accepted. Empty strings, empty bytes, zero bytes and JSON `null` are
ordinary values, not tombstones. `decodePayload(bytes)` in `@mip0018/codec` applies all of this and never throws.

## 4. Apply in chain order

Every record belongs to the token identity **`(network, contractAddress, domainSep, kind)`**: `network` is where you
read the event, `contractAddress` comes from the **event record — never from the payload** (so a contract can describe
only its own tokens), `domainSep` and `kind` come from the header. Kinds 1, 2 and 3 of one asset are three identities.

Apply accepted events in chain order — block, transaction within the block, event within the transaction, record
within the event. Within a transaction, the MIP fixes the event order (since `78ecbb4`): "the guaranteed part of every
intent (in ascending segment id), then each successful fallible segment (in ascending segment id); within a part,
actions and their operations in order". The indexer's event ids follow it; if you decode raw transactions yourself,
`decodeTransaction` + `applied` in `@mip0018/midnight` produce exactly that order (test
[`event-order.test.ts`](../packages/midnight/test/event-order.test.ts)), and `mip0018 verify` checks per transaction
that the indexer's order equals the ledger's.

- **A record sets its field's current value**, replacing any earlier one. An event changes only the keys it carries; it
  is not a snapshot. A replaced value is never shown as current and never used as a fallback; you MAY keep it as
  clearly marked history.
- **A Null record (any key) is a tombstone for the whole identity**: hide it, clear all its fields and its history. A
  second tombstone changes nothing. The next non-Null record makes the identity visible again with only that field —
  nothing from before the tombstone returns (vector `S3c`).
- **Reorganizations**: follow finalized blocks only, or recompute when blocks are removed. With the reference
  consumer: `state.rollbackTo(network, height)` drops everything above `height` and recomputes (vectors `S4a`, `S4b`).

`MetadataState.apply` refuses an event whose `(block, tx, event)` is not after the previous one on that network
(`ChainOrderError`), so an ordering bug fails loudly instead of producing a wrong state.

## 5. Present

### Common fields

| Key | Usable when | Use |
|---|---|---|
| `name` | type 1 (UTF-8), not empty | display name |
| `symbol` | type 1 (UTF-8), not empty | ticker |
| `decimals` | type 2 (unsigned integer) | `amount / 10^decimals` |
| `standards` | type 1, valid list (below) | standards the token *claims* |

A field whose current value has the wrong type or form is **unusable**: show no value, and never fall back to an
earlier one (vectors `S5a`–`S5c`). A field that was never set has no value: **never assume a default** such as 0 or 18
decimals — without `decimals`, show raw amounts or nothing. `identity.common` in the reference consumer holds exactly
the usable values.

### `standards`

A list of identifiers separated by single spaces; an identifier is non-empty and has no byte in `0x00`–`0x20` or
`0x7f` (other Unicode spaces are bytes above `0x7f`, so they are allowed by the MIP's byte rule). An empty value claims nothing; a
malformed value is unusable, not empty. `parseStandards` implements it.

The list is **self-declared**. You MAY use an identifier you recognise to pick a UI or adapter you already trust; you
MUST NOT treat it as proof that the token conforms, and MUST NOT fetch or run code because of it. A contract that claims
`mip-0004` may implement none of it.

### Symbol groups

Group visible identities of the **same `(network, contractAddress)`** that have the same usable `symbol`, compared as
exact bytes (`ACME` ≠ `acme` ≠ ` ACME`). Groups are presentation only: each member keeps its own fields, and a rename,
symbol change or tombstone of one member changes no other. `state.groups()` returns them. Never group across contracts
or networks.

Grouping is a SHOULD. The MIP's Testing text (S9, since `78ecbb4`) says "two outcomes are valid: no groups at all, or
exactly the following groups", so a consumer that does not group passes S9, and the vector runner compares only groups
of two or more members. Whether an identity alone with its symbol is a "group of one" is not settled by the MIP (note
N20); the reference consumer reports such groups, the runner ignores them.

### Amounts

`formatAmount(raw, decimals)` divides exactly with big integers: with `decimals = 2`, `123456` shows as `1234.56`
(vector `S8`, which applies to "a consumer that displays amounts"; an indexer that only serves raw fields omits
`display` and the runner reports S8 as not applicable). There is no cap on `decimals` (owner ruling F3): large values render exactly, without floating point.

### Colors

Kinds 1 (shielded coins) and 2 (unshielded UTXOs) have a color, `tokenType(domainSep, contractAddress)`; kind 3
(ledger tokens) has none. "A shielded and an unshielded mint with the same `domainSep` have the same color; the kind
is given by what the user holds (a shielded coin → kind 1, an unshielded UTXO → kind 2), not by the color" (MIP Lookup,
since `78ecbb4`; note N3).

## 6. Untrusted input

Every payload byte is attacker-controlled (MIP "Consuming"):

- **Bounds-check every length before slicing.** The reference decoder reads every byte through a bounds-checked
  accessor; a fuzz test runs 2 × 100,000 random payloads without an exception or an out-of-range read.
- **Harden the UTF-8, JSON and URI parsers.** Strict UTF-8 only; a 219-byte JSON value can still nest about 100 levels deep,
  so use a parser that copes; use a URI check with linear running time (the reference grammar decides 219-character
  inputs in under 20 ms).
- **Never fetch a URI from a value** without the precautions you apply to any remote content. A valid URI is not a safe
  one: `javascript:alert(1)` passes the RFC 3986 rule. The reference code validates URIs and never fetches them.
- **Escape every value** where you render it (HTML, terminal, logs). Names and symbols can carry control characters
  or look-alike characters.
- **`standards` never selects code** (above).

## 7. Impersonation and curation

Any contract can emit any `name` or `symbol`, including one another token already uses (MIP "Security
Considerations"):

- **Keep every claim attached to its token identity** and **show that identity**: contract address, `domainSep`, kind
  (and the color for kinds 1 and 2) next to the name. `mip0018 list` and `lookup` print it for every identity.
- **Require a curation signal** — an allowlist, a registry attestation or the user's confirmation — before presenting
  a token as a known asset. MIP-0018 events are the issuer-written base layer; deciding which "ACME" is genuine is
  curation, which this repository does not provide.
- **The same symbol in two contracts is not the same asset**, and membership of a group within one contract does not
  prove its members are interchangeable.
- **Unauthorized updates**: anyone who can call a contract's emitting circuit can rename or withdraw its token. Showing
  earlier values as marked history (`new MetadataState({ keepHistory: true })`, `mip0018 list --history`) makes hostile
  renames visible; a tombstone removes that history from metadata views, although the events stay on chain. A
  contract's maintenance authority can also insert new circuits, so it can change the metadata too
  ([upgrade guide, Limits](upgrade-guide.md#limits)).

## 8. From a coin to its metadata: the mint scanner

A wallet holding a shielded coin or an unshielded UTXO knows only its color. To find the token:

1. **Compute colors, never read them.** `color = tokenType(domainSep, contractAddress)` (Compact standard library;
   ledger-v9 `rawTokenType`; `tokenType` in `@mip0018/midnight`). No payload field holds a color.
2. **Build a table from mints**: for every successful contract call, the `shieldedMints` / `unshieldedMints` effects
   (`domainSep → amount`) of the parts of the transaction that were applied give `color → (contractAddress,
   domainSep)`. "A mint is a `shieldedMints` or `unshieldedMints` effect of a contract call" (MIP Lookup, since
   `78ecbb4`; note N10): mint events a contract emits and UTXO token types are not sources for this table.
3. **Resolve** a held color through the table to `(contractAddress, domainSep)`, take kind 1 for a coin or 2 for a UTXO,
   and read that identity's events (steps 1–5).

Kind 3 has no color: list the contract's kind-3 events instead (`mip0018 list --contract <address>`).

The reference scanner reads every block from a start height — near the deployments on a public network, 0 or 1 on a
local chain — keeps a resumable checkpoint (re-run the same command to resume; `--follow` keeps following new
blocks), and `lookup` resolves a color through it. On Stagenet ([`examples/verify`](../examples/verify/README.md#3-from-a-coin-to-its-metadata-index-and-lookup),
case [IDX](../deployments/stagenet/cases/IDX/README.md)):

```sh
docker/run.sh mip0018 -- index --network stagenet --from-height 714485 --to-height 715183 \
  --state deployments/stagenet/cases/IDX/index
docker/run.sh mip0018 -- lookup --network stagenet --state deployments/stagenet/cases/IDX/index \
  --color 8e01e39293a9e21ee2685da06ce487fffafbc1a982d53fcb1a72520f18518484
```

```text
color       8e01e39293a9e21ee2685da06ce487fffafbc1a982d53fcb1a72520f18518484
table       contract a3df52605d8b7210aa3e5cdc82de4bb2911975bc42c1a68be77044723b705f21  domainSep 6d69702d303031383a6578616d706c653a756e736869656c6465640000000000
minted      unshielded ×1 first at 714617
metadata    live indexer at block 715963
  identity  domainSep 6d69702d303031383a6578616d706c653a756e736869656c6465640000000000  kind 2 (native unshielded)  visible  color 8e01e39293a9e21ee2685da06ce487fffafbc1a982d53fcb1a72520f18518484
    name         "Acme Public"                            type 1  usable
    symbol       "APUB"                                   type 1  usable
    decimals     6                                        type 2  usable
    display      1 base unit = 0.000001 APUB
```

A color that was never minted in the scanned range is reported as such (exit 3) — a published identity is not proof
that coins of its color exist (C05's bronze type).

## 9. Test your consumer with the vectors

The [vectors](../vectors/README.md) are language-neutral JSON and binary fixtures for every normative MIP test (67)
plus informative extras (43). To run them against your consumer, write a small adapter program in any language that
follows the [runner contract](../vectors/README.md#runner-contract): it reads one JSON request per line on stdin
(`decode` one event, or `state` for a sequence of events in chain order) and writes one JSON response per line.
[`packages/consumer/bin/vector-adapter.js`](../packages/consumer/bin/vector-adapter.js) (about 100 lines) is the
template.

```sh
docker/run.sh mip0018 -- vectors run                     # the reference consumer: normative 67/67 passed
docker/run.sh exec 'node vectors/tools/run.ts --consumer "node packages/consumer/bin/vector-adapter.js" --only S3,S4a'
```

The runner needs only Node ≥ 24, so it also runs outside Docker against your own adapter:
`node vectors/tools/run.ts --consumer "./my-wallet-adapter" --normative-only --notes --json report.json`. Exit 0 means
every normative vector passed; `reason` and `offset` differences are informative notes, never failures. Report the
four common keys of every identity; other keys may be left out ("Indexers MAY index only some tokens or keys"); omit
`groups` if you do not group symbols and `display` if you do not display amounts — the runner then reports S9/S8 as
not applicable instead of failing them. Passing every
vector is the MIP's acceptance criterion for a consumer (the MIP asks for two independent ones; this repository
provides the reference and the runner — a second consumer is left open, question Q7).

## Reference

| Package / command | What |
|---|---|
| [`@mip0018/codec`](../packages/codec/README.md) | `classifyEvent`, `decodePayload`, `encodePayload`, `checkValue`, `isRfc3986Uri`, `splitMiscData` — dependency-free |
| [`@mip0018/consumer`](../packages/consumer/README.md) | `MetadataState` (`apply`, `rollbackTo`, `identities`, `groups`, `display`, `history`), `formatAmount`, `parseStandards` |
| [`@mip0018/midnight`](../packages/midnight/README.md) | indexer and node access, `tokenType`, raw-transaction decoding, `verify`, `list`, the mint scanner |
| [`mip0018` CLI](../packages/cli/README.md) | `verify`, `list`, `index`, `lookup`, `recheck`, `vectors run` — no wallet |
| [`examples/verify`](../examples/verify/README.md) | the wallet-free walkthrough on the real Stagenet cases |
| [`deployments/stagenet`](../deployments/stagenet/README.md) | 12 recorded cases, each re-checkable with one command |
