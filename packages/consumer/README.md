# `@mip0018/consumer`

The reference MIP-0018 consumer: applies `TokenMetadata` events in chain order and evaluates the common fields.
Depends only on `@mip0018/codec`. It passes 100 % of the normative vectors and all informative ones (`vectors/`).

```ts
import { MetadataState, formatAmount } from '@mip0018/consumer';

const state = new MetadataState({ tokenType /* optional: (domainSep, contractAddress) => color, e.g. ledger-v9 rawTokenType */ });
state.apply({ network, contractAddress, block, tx, event, type: 'Misc', name, payload }); // in chain order per network
state.rollbackTo(network, block);  // reorganization: recompute from the remaining canonical events
state.identities();                // [{ network, contractAddress, domainSep, kind, visible, colored, color, fields, common }]
state.groups();                    // symbol groups per (network, contractAddress), exact bytes
state.display(identity, 123456n);  // { decimals: 2n, text: '1234.56' } — or nulls when there is no usable decimals
```

| MIP rule | Implementation |
|---|---|
| Chain order (block, tx, event, record) | `apply` throws `ChainOrderError` on a non-increasing position per network; records apply in order |
| Token identity | `(network, contractAddress from the event record, domainSep, kind)` |
| Latest value wins; marked history (MAY) | `keepHistory: true` keeps replaced values in `history(key, keyHex)` — never current, never a fallback |
| Tombstone (Null, any key) | hides the identity, clears every field and its history; repeating it changes nothing; the next record revives the identity with only that field |
| Unusable fields, no defaults | `usable` per common field (`name`/`symbol`: non-empty UTF-8; `decimals`: type 2; `standards`: list format); `common` holds only usable values; no fallback, no default `decimals` |
| `standards` | `parseStandards`: single-space separated, no byte in 0x00–0x20 or 0x7f; empty = no claims; malformed = unusable |
| Symbol grouping | visible identities with the same usable `symbol` bytes within one `(network, contractAddress)` |
| Display | `formatAmount(raw, decimals)`: exact `bigint` arithmetic for any `decimals` (plain up to 1 000 fractional digits, exact scientific notation beyond; trailing fraction zeros trimmed by default) |
| Reorganizations | every accepted event is retained per network; `rollbackTo` recomputes (or follow finalized blocks only) |
| Color | kinds 1 and 2 only, through the injected `tokenType` hook (kept outside so this package stays dependency-free); never called for kind 3 |

`bin/vector-adapter.js` implements the runner contract (`vectors/README.md`) and is a template for adapters in other
languages:

```sh
node vectors/tools/run.ts --consumer "node packages/consumer/bin/vector-adapter.js"
```

`@mip0018/consumer/internal` exposes rule switches used only by the rule-mutation test (`npm test -w packages/consumer -- mutations`).
