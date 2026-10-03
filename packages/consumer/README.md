# `@mip0018/consumer`

The reference MIP-0018 consumer: applies `TokenMetadata` events in chain order and evaluates the common fields.
Depends only on `@mip0018/codec`. It passes 100 % of the normative vectors and all informative ones (`vectors/`).

```ts
import { MetadataState, formatAmount } from '@mip0018/consumer';

const state = new MetadataState({ tokenType /* optional: (domainSep, contractAddress) => color, e.g. ledger-v9 rawTokenType */ });
state.apply({ network, contractAddress, block, tx, event, type: 'Misc', name, payload }); // in chain order per network
state.rollbackTo(network, block);  // reorganization: recompute from the remaining canonical events
state.identities();                // [{ network, contractAddress, domainSep, kind, colored, color, fields, common }] — identities with ≥ 1 field
state.groups();                    // symbol groups per (network, contractAddress), exact bytes
state.display(identity, 123456n);  // { decimals: 2n, text: '1234.56' } — or nulls when there is no usable decimals
```

| MIP rule | Implementation |
|---|---|
| Chain order (block, tx, event, record) | `apply` throws `ChainOrderError` on a non-increasing position per network; records apply in order |
| Token identity | `(network, contractAddress from the event record, domainSep, kind)` |
| Latest value wins; marked history (MAY) | `keepHistory: true` keeps replaced values in `history(key, keyHex)` — never current, never a fallback; a Null record drops its own field's history |
| Null record (tombstone) | deletes its own field (value and history; no fallback); a Null record for a field without a value has no effect; a later non-Null record sets the field again and nothing from before returns |
| A token identity exists only while one of its fields has a value | when its last field is deleted the identity is removed with all its history: `identities()`, `identity(…)`, `groups()` and `history(…)` do not reference it, as if it had never been described; Null records alone never create one; the next non-Null record describes it again with only that field. To withdraw a token, emit a Null record for each of its keys in one event (`withdrawRecords()` in `@mip0018/codec` for the common four) |
| Unusable fields, no defaults | `usable` per common field (`name`/`symbol`: non-empty UTF-8; `decimals`: type 2; `standards`: list format); `common` holds only usable values; no fallback, no default `decimals` |
| `standards` | `parseStandards`: single-space separated, no byte in 0x00–0x20 or 0x7f; empty = no claims; malformed = unusable |
| Symbol grouping | identities with the same usable `symbol` bytes within one `(network, contractAddress)`; deleting a member's `symbol` removes it from its group |
| Display | `formatAmount(raw, decimals)`: exact `bigint` arithmetic for any `decimals` (plain up to 1 000 fractional digits, exact scientific notation beyond; trailing fraction zeros trimmed by default) |
| Reorganizations | every accepted event is retained per network; `rollbackTo` recomputes (or follow finalized blocks only) |
| Color | kinds 1 and 2 only, through the injected `tokenType` hook (kept outside so this package stays dependency-free); never called for kind 3 |

`bin/vector-adapter.js` implements the runner contract (`vectors/README.md`) and is a template for adapters in other
languages:

```sh
node vectors/tools/run.ts --consumer "node packages/consumer/bin/vector-adapter.js"
```

`@mip0018/consumer/internal` exposes rule switches used only by the rule-mutation test (`npm test -w packages/consumer -- mutations`).
