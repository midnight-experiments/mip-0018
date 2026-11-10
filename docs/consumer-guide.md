# Consumer guide — read MIP-0018 token metadata (wallets, explorers, indexers)

How to turn a contract's MIP-0018 events into the name, symbol and decimals a wallet or explorer shows, following the
pinned MIP text ([MIP-0018 @ `338ea194`](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/338ea194bbe7c4e5d1829234a503b7c1b11ebf0f/mips/mip-0018-on-chain-token-metadata.md)).
The reference implementation of every step is in this repository and passes all normative vectors:

| Step | Reference code | Wallet-free command |
|---|---|---|
| 1. Fetch a contract's events | [`@mip0018/midnight`](../packages/midnight/README.md) (`Indexer`, `listMetadata`) | `mip0018 list` |
| 2–3. Classify, decode, validate | [`@mip0018/codec`](../packages/codec/README.md) (`classifyEvent`, `decodePayload`) | `mip0018 check-event` |
| 4–5. Apply, present | [`@mip0018/consumer`](../packages/consumer/README.md) (`MetadataState`, `formatAmount`) | `mip0018 list` |
| 8. Color → token | [`@mip0018/midnight`](../packages/midnight/README.md) (`tokenType`, scanner) | `mip0018 index`, `mip0018 lookup` |
| 9. Test your own consumer | [`vectors/`](../vectors/README.md#runner-contract) (runner contract) | `mip0018 vectors run` |

The commands run in the pinned Docker image ([`packages/cli`](../packages/cli/README.md)):
`docker/run.sh mip0018 -- <command> …`. The issuer side is the [issuer guide](issuer-guide.md); every MUST/SHOULD and
its test is in the [conformance matrix](conformance-matrix.md).

## 1. Fetch the events

MIP-0018 metadata travels in MIP-0002 `Misc` events, bound to the contract that emitted them. The Midnight indexer
(GraphQL v4; preview, preprod and mainnet serve schema 4.4.101, Blockfrost the same API for preprod and mainnet) returns a contract's events with `contractEvents`, a surface the schema
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
  A1 event is 127 bytes in the ledger's raw data (32 name + 95 content bytes). Informative vectors: `vectors/informative/zero-extension/`.
- Order the events of one transaction as the ledger executes them (MIP "Applying records"; step 4).
- Completeness (MIP "Consuming"): a verified event does not prove that no later update or tombstone exists. Read every
  event of the contract, not a filtered subset.

A complete minimal consumer — fetch, apply in chain order, present — for one contract on preview (the contract address
is its argument; below, the contract of preview case [C04](../deployments/preview/cases/C04/README.md): one asset as
kinds 1, 2 and 3):

```ts
import { fromHex, toHex } from '@mip0018/codec';
import { MetadataState, formatAmount } from '@mip0018/consumer';
import { tokenType } from '@mip0018/midnight'; // ledger-v9 rawTokenType; any equal implementation works

const INDEXER = 'https://indexer.preview.midnight.network/api/v4/graphql';
const CONTRACT = process.argv[2]; // 64 hex digits

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
    network: 'preview',
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

for (const id of state.identities()) { // only identities that have at least one served field
  const color = id.color ? toHex(id.color) : '-';
  const { name, symbol, decimals } = id.common; // usable values only; absent = show nothing
  console.log(`kind ${id.kind} ${name ?? '?'} (${symbol ?? '?'}) decimals ${decimals ?? '-'} color ${color}`);
  if (decimals !== undefined) console.log(`  123456 base units = ${formatAmount(123456n, decimals)} ${symbol ?? ''}`);
}
for (const g of state.groups()) console.log(`group "${new TextDecoder().decode(g.symbol)}": ${g.members.length} identities`);
```

Saved as `consumer-example.ts` at the repository root and run with
`docker/run.sh exec 'node consumer-example.ts 63d973a7df1b383cca57d8fab9c2a2ee3fa08bc92baada5dc3f12863ad1bfe93'`
(2026-11-09):

```text
event 13263: accept
event 13264: accept
event 13265: accept
kind 1 Acme Dollar (ACD) decimals 2 color 056c310ebcb469c9c5b8974842104ada748a84c2c42824be0f1ed165e3d81b2a
  123456 base units = 1234.56 ACD
kind 2 Acme Dollar (ACD) decimals 2 color 056c310ebcb469c9c5b8974842104ada748a84c2c42824be0f1ed165e3d81b2a
  123456 base units = 1234.56 ACD
kind 3 Acme Dollar (ACD) decimals 2 color -
  123456 base units = 1234.56 ACD
group "ACD": 3 identities
```

The same with the CLI, which also cross-checks the indexer's tip against the node and prints every served field, the groups
and the source events ([`examples/verify`](../examples/verify/README.md#2-everything-a-contract-published-list)):

```sh
docker/run.sh mip0018 -- list --network preview --contract 63d973a7df1b383cca57d8fab9c2a2ee3fa08bc92baada5dc3f12863ad1bfe93
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

Vectors: `I1a`, `I1b`, `I2a`, `I2b`, `I3`. On preview: [C07](../deployments/preview/cases/C07/README.md) carries
`[v2]` and foreign names next to valid events.

## 3. Decode and validate

The 256-byte payload is a header — `domainSep` (32 bytes) and `kind` (1 byte: 1 shielded UTXO, 2 unshielded UTXO,
3 contract token) —
then records `keyLen | key | valType | valLen | value` back to back from byte 33, then zero padding. Check it as the
MIP says:

1. `kind` is 1, 2 or 3;
2. read records until byte 256 or a zero `keyLen`; after a zero `keyLen` every remaining byte is zero; every part of a
   record fits in the 256 bytes and its value follows its type's rule;
3. at least one record.

**Any failure rejects the whole event**: apply none of its records, not even the valid ones before the bad one
(vectors `R6a`, `R6b`). Rejecting one event never affects another, even in the same transaction (`S7a`, `S7b`;
preview [C08](../deployments/preview/cases/C08/README.md)).

| `valType` | Rule as implemented here |
|---:|---|
| 0 bytes | anything |
| 1 UTF-8 string | strict UTF-8 (no overlongs, surrogates or code points above U+10FFFF); may be empty |
| 2 unsigned integer | 1–31 bytes, little-endian; decode every width to a big integer (`06` and `06` + 15 zero bytes are both 6) |
| 3 JSON | strict UTF-8, then your platform's JSON parser must accept the text as exactly one value (the MIP's rule is "one complete UTF-8 JSON value", RFC 8259) |
| 4 URI | strict UTF-8, then the RFC 3986 `URI` rule (MIP Value types: "a scheme is required, a fragment is allowed, and relative references are not. The value is ASCII only" — the URI definition ERC-721 uses): `https://acme.example/logo.png#v2` and `ipfs://…` accept; `https://ä.example/`, `https://acme.example/a b.png` and `/relative/path` reject ([26 informative cases](../vectors/informative/uri/README.md)) |
| 5 Null | `valLen` 0 (a tombstone: deletes its field) |
| 6–255 | reserved: reject the event |

Keys are exact bytes: case-sensitive, no trimming or normalisation, zero bytes significant (`symbol` and `symbol\0`
are different keys). **Keys MUST be valid UTF-8**: a key that is not rejects the whole event (vector `R5i`; preview
[C07](../deployments/preview/cases/C07/README.md) step `A3c`). Empty strings, empty bytes, zero bytes and JSON `null` are
ordinary values, not tombstones. `decodePayload(bytes)` in `@mip0018/codec` applies all of this and never throws.

## 4. Apply in chain order

Every record belongs to the token identity **`(network, contractAddress, domainSep, kind)`**: `network` is where you
read the event, `contractAddress` comes from the **event record — never from the payload** (so a contract can describe
only its own tokens), `domainSep` and `kind` come from the header. Kinds 1, 2 and 3 of one asset are three identities.

Apply accepted events in chain order — block, transaction within the block, event within the transaction, record
within the event. Within a transaction, the MIP fixes the event order: "the guaranteed part of every
intent (in ascending segment id), then each successful fallible segment (in ascending segment id); within a part,
actions and their operations in order". The indexer's event ids follow it; if you decode raw transactions yourself,
`decodeTransaction` + `applied` in `@mip0018/midnight` produce exactly that order (test
[`event-order.test.ts`](../packages/midnight/test/event-order.test.ts)), and `mip0018 check-event` checks per transaction
that the indexer's order equals the ledger's.

- **A record sets its field's current value**, replacing any earlier one. An event changes only the keys it carries; it
  is not a snapshot. A replaced value is never shown as current and never used as a fallback; you MAY keep it as
  clearly marked history.
- **A Null record deletes its own field** (MIP "Applying records"): stop serving that field's value
  and its earlier values (drop its marked history too) and never fall back to an earlier value. The identity's other
  fields stay (vector `S3a`). A Null record for a field that has no value has no effect (`S3b`).
- **A token identity exists only while at least one of its fields has a value.** Once its last field is deleted, do
  not reference the identity at all — not in listings, lookups, groups or metadata history — "as if it had never been
  described" (`S3c`); Null records alone never create one. A later non-Null record describes it again with only that
  field; nothing from before returns (`S3d`). An identity whose only fields are keys you do not serve (below) is not
  referenced either. The reference consumer deletes the identity with its history:
  `identities()`, `identity(…)`, `groups()` and `history(…)` do not return it. An issuer withdraws a token by
  emitting a Null record for each of its keys, in one event (`withdraw` in the Compact module).
- **Reorganizations**: follow finalized blocks only, or recompute when blocks are removed. With the reference
  consumer: `state.rollbackTo(network, height)` drops everything above `height` and recomputes (vectors `S4a`, `S4b`: removing
  the block that deleted an identity's last fields restores them).

`MetadataState.apply` refuses an event whose `(block, tx, event)` is not after the previous one on that network
(`ChainOrderError`), so an ordering bug fails loudly instead of producing a wrong state.

## 5. Present

### Served keys

**Serve only the common keys and the keys of standards the token currently declares** (MIP "Keys": consumers "MUST
NOT serve a key that is neither defined in Common fields nor defined by a standard the token currently declares in
`standards`. What they store is up to them."). Any other accepted record — `foo = "x"`, a key `SYMBOL`, `symbol\0` — is
valid but not shown, listed or returned by an API (vectors `S10a`, `A3a-state`, `S9a`). The served keys follow the
token's current `standards`: a key that a standard defines is served while `standards` lists that standard, whenever
its record arrived — sent before the standard was declared, it is served once it is declared, not served after the
standard is removed, and served again after it is declared again (`S10b`–`S10e`). Keep every accepted record (or
re-read the events) so that a change of `standards` can be applied. The reference consumer stores every record and
takes key definitions as `new MetadataState({ definedKeys: { 'mip-00xx': [{ key: 'k', valType: 1 }] } })`; no MIP
defines keys yet, so by default only the common keys are served. `mip0018 check-event` prints every record of one
event and marks a key that is not a common key "not served"; `list` and `lookup` show what is served.

### Common fields

| Key | Usable when | Use |
|---|---|---|
| `name` | type 1 (UTF-8), not empty | display name: its first 64 characters |
| `symbol` | type 1 (UTF-8), not empty | ticker: its first 12 characters |
| `decimals` | type 2 (unsigned integer) | `amount / 10^decimals` |
| `standards` | type 1, valid list (below) | standards the token *claims* |
| `image` | type 4 (URI) | image or logo of the token (below) |
| `image_sha256` | type 0, exactly 32 bytes | SHA-256 of the file at `image` (below) |

A character is a grapheme cluster (MIP "Terminology", Unicode UAX #29), not a byte or a code point: `e` + U+0301, a
flag (two regional indicators) and a Hangul syllable written as L+V+T jamo are one character each. A longer `name` or
`symbol` stays usable and is truncated to its first 64 / 12 characters for display (vectors `S11a`, `S11b`;
`Intl.Segmenter` with `granularity: 'grapheme'` in JavaScript); the stored bytes do not change, and grouping compares
them (below).

A field whose current value has the wrong type or form is **unusable**: show no value, and never fall back to an
earlier one (vectors `S5a`–`S5c`). A field that was never set has no value: **never assume a default** such as 0 or 18
decimals — without `decimals`, show raw amounts or nothing. `identity.common` in the reference consumer holds exactly
the usable values.

If the token also has standard getters (`name()`, `symbol()`, `decimals()` of MIP-0004/0011/0014), the events are what
this MIP serves: "A later update, such as a rename, is the token's current metadata for consumers of this MIP even
where the getters cannot change" (Common fields). A MIP that defines a token standard may
restrict or override that for tokens that declare the standard in `standards`.

### `image` and `image_sha256`

`image` is a URI; this repository never fetches it. If you display the image, fetch it with the precautions you apply
to any remote content and **check it against `image_sha256` when that field is set**: content whose SHA-256 differs
MUST NOT be displayed (vector `S12a`). An `image_sha256` that is not 32 bytes is unusable (`S12b`); no content's
SHA-256 equals it, so the reference check (`imageContentAllowed`) refuses every content for it (informative
`INF-IMG-1`). Without `image_sha256` the content cannot be checked (`INF-IMG-2`). Images are untrusted content: render
them in a way that cannot run scripts — not as inline SVG (MIP "Security Considerations").

### `standards`

A list of identifiers separated by single spaces; an identifier is non-empty and has no byte in `0x00`–`0x20` or
`0x7f` (other Unicode spaces are bytes above `0x7f`, so they are allowed by the MIP's byte rule). An empty value claims nothing; a
malformed value is unusable, not empty. `parseStandards` implements it.

The list is **self-declared**. You MAY use an identifier you recognise to pick a UI or adapter you already trust; you
MUST NOT treat it as proof that the token conforms, and MUST NOT fetch or run code because of it. A contract that claims
`mip-0004` may implement none of it.

### Symbol groups

Group identities of the **same `(network, contractAddress)`** that have the same usable `symbol`, compared as
exact bytes (`ACME` ≠ `acme` ≠ ` ACME`) — the stored bytes, not the truncated display form (two 15-character symbols
that share their first 12 characters look alike but are two groups, informative `INF-LEN-3`). Groups are presentation only: each member keeps its own fields, and a rename
or symbol change of one member changes no other; deleting a member's `symbol` (a Null record at `symbol`) removes it
from its group (`S9d`), and an identity with no field left is in no group. `state.groups()` returns them. Never group across contracts
or networks.

Grouping is a SHOULD. The MIP's Testing text (S9) says "two outcomes are valid: no groups at all, or
exactly the following groups", so a consumer that does not group passes S9, and the vector runner compares only groups
of two or more members. Whether an identity alone with its symbol is a "group of one" is not settled by the MIP;
the reference consumer reports such groups, the runner ignores them.

### Amounts

`formatAmount(raw, decimals)` divides exactly with big integers: with `decimals = 2`, `123456` shows as `1234.56`
(vector `S8`, which applies to "a consumer that displays amounts"; an indexer that only serves raw fields omits
`display` and the runner reports S8 as not applicable). There is no cap on `decimals` (the MIP sets none): large values render exactly, without floating point.

### Colors

Kinds 1 (shielded UTXO) and 2 (unshielded UTXO) — contract-issued UTXO tokens — have a color,
`tokenType(domainSep, contractAddress)`; kind 3 (contract tokens) has none. "A shielded and an unshielded mint with the same `domainSep` have the same color; the kind
is given by what the user holds (a shielded coin → kind 1, an unshielded UTXO → kind 2), not by the color" (MIP Lookup).

## 6. Untrusted input

Every payload byte is attacker-controlled (MIP "Consuming"):

- **Bounds-check every length before slicing.** The reference decoder reads every byte through a bounds-checked
  accessor; a fuzz test runs 2 × 100,000 random payloads without an exception or an out-of-range read.
- **Harden the UTF-8, JSON and URI parsers.** Strict UTF-8 only; a 219-byte JSON value can still nest about 100 levels deep,
  so use a parser that copes; use a URI check with linear running time (the reference grammar decides 219-character
  inputs in under 20 ms).
- **Never fetch a URI from a value** without the precautions you apply to any remote content. A valid URI is not a safe
  one: `javascript:alert(1)` passes the RFC 3986 rule. The reference code validates URIs and never fetches them;
  `image` content is checked against `image_sha256` and rendered without scripts (above).
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
  renames visible; a Null record removes that field's history from metadata views, although the events stay on chain. A
  contract's maintenance authority can also insert new circuits, so it can change the metadata too
  ([upgrade guide, Limits](upgrade-guide.md#limits)).

## 8. From a coin to its metadata: the mint scanner

A wallet holding a shielded coin or an unshielded UTXO knows only its color. To find the token:

1. **Compute colors, never read them.** `color = tokenType(domainSep, contractAddress)` (Compact standard library;
   ledger-v9 `rawTokenType`; `tokenType` in `@mip0018/midnight`). No payload field holds a color.
2. **Build a table from mints**: for every successful contract call, the `shieldedMints` / `unshieldedMints` effects
   (`domainSep → amount`) of the parts of the transaction that were applied give `color → (contractAddress,
   domainSep)`. "A mint is a `shieldedMints` or `unshieldedMints` effect of a contract call" (MIP Lookup): mint events a contract emits and UTXO token types are not sources for this table.
3. **Resolve** a held color through the table to `(contractAddress, domainSep)`, take kind 1 for a coin or 2 for a UTXO,
   and read that identity's events (steps 1–5).

Kind 3 has no color: list the contract's kind-3 events instead (`mip0018 list --contract <address>`).

The reference scanner reads every block from a start height — near the deployments on a public network, 0 or 1 on a
local chain — keeps a resumable checkpoint (re-run the same command to resume; `--follow` keeps following new
blocks), and `lookup` resolves a color through it. On preview
([`examples/verify`](../examples/verify/README.md#3-from-a-coin-to-its-metadata-index-and-lookup), case
[IDX](../deployments/preview/cases/IDX/README.md)):

```sh
docker/run.sh mip0018 -- index --network preview --from-height 41531 --to-height 42095 \
  --state deployments/preview/cases/IDX/index
docker/run.sh mip0018 -- lookup --network preview --state deployments/preview/cases/IDX/index \
  --color 651ab6b0dd7ccb521586f3c14e235842171cbf27ba43ad5d3ac52aa991ce77d0
```

```text
color       651ab6b0dd7ccb521586f3c14e235842171cbf27ba43ad5d3ac52aa991ce77d0
table       contract f6e2fac7659ec945494ceaed8c17c5f6cc88af9e6d7f83c9f88f6c9f33b42a1c  domainSep 6d69702d303031383a6578616d706c653a756e736869656c6465640000000000
minted      unshielded ×1 first at 41605
metadata    live indexer at block 42469
  identity  domainSep 6d69702d303031383a6578616d706c653a756e736869656c6465640000000000  kind 2 (unshielded UTXO)  color 651ab6b0dd7ccb521586f3c14e235842171cbf27ba43ad5d3ac52aa991ce77d0
    name         "Acme Public"                            type 1  usable
    symbol       "APUB"                                   type 1  usable
    decimals     6                                        type 2  usable
    display      1 base unit = 0.000001 APUB
```

A color that was never minted in the scanned range is reported as such (exit 3) — a published identity is not proof
that coins of its color exist (C05's bronze type). A color whose identity was withdrawn (every field deleted) resolves
to its contract and `domainSep` but shows no metadata, exactly like a token that was never described.

## 9. Test your consumer with the vectors

The [vectors](../vectors/README.md) are language-neutral JSON and binary fixtures for every normative MIP test (78)
plus informative extras (49). To run them against your consumer, write a small adapter program in any language that
follows the [runner contract](../vectors/README.md#runner-contract): it reads one JSON request per line on stdin
(`decode` one event, or `state` for a sequence of events in chain order) and writes one JSON response per line.
[`packages/consumer/bin/vector-adapter.js`](../packages/consumer/bin/vector-adapter.js) (about 100 lines) is the
template.

```sh
docker/run.sh mip0018 -- vectors run                     # the reference consumer: normative 78/78 passed
docker/run.sh exec 'node vectors/tools/run.ts --consumer "node packages/consumer/bin/vector-adapter.js" --only S3,S4a'
```

The runner needs only Node ≥ 24, so it also runs outside Docker against your own adapter:
`node vectors/tools/run.ts --consumer "./my-wallet-adapter" --normative-only --notes --json report.json`. Exit 0 means
every normative vector passed; `reason` and `offset` differences are informative notes, never failures. Load the
request's `definedKeys` (S10b–S10e define a test standard) and report the served keys of every identity — the six
common keys and the keys of the declared standards — and no other key; omit `groups` if you do not group symbols,
`display` if you do not display amounts and `images` if you do not display images — the runner then reports
S9/S8/S12a as not applicable instead of failing them. Passing every
vector is the MIP's acceptance criterion for a consumer (the MIP asks for two independent ones; this repository
provides the reference and the runner, not a second consumer).

## Reference

| Package / command | What |
|---|---|
| [`@mip0018/codec`](../packages/codec/README.md) | `classifyEvent`, `decodePayload`, `encodePayload`, `checkValue`, `isRfc3986Uri`, `splitMiscData` — dependency-free |
| [`@mip0018/consumer`](../packages/consumer/README.md) | `MetadataState` (`apply`, `rollbackTo`, `identities`, `groups`, `display`, `history`, `imageContentAllowed`; `definedKeys`), `formatAmount`, `parseStandards`, `characters` |
| [`@mip0018/midnight`](../packages/midnight/README.md) | indexer and node access, `tokenType`, raw-transaction decoding, `checkEvent`, `list`, the mint scanner |
| [`mip0018` CLI](../packages/cli/README.md) | `check-event`, `list`, `index`, `lookup`, `recheck`, `vectors run` — no wallet |
| [`examples/verify`](../examples/verify/README.md) | the wallet-free walkthrough on the preview cases |
| [`deployments/preview`](../deployments/preview/README.md) | 13 recorded cases, each re-checkable with one command |
