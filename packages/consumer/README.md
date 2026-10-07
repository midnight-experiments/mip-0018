# `@mip0018/consumer`

The reference MIP-0018 consumer: applies `TokenMetadata` events in chain order and evaluates the common fields.
Depends only on `@mip0018/codec`. It passes 100 % of the normative vectors and all informative ones (`vectors/`).

```ts
import { MetadataState, formatAmount } from '@mip0018/consumer';

const state = new MetadataState({
  tokenType, // optional: (domainSep, contractAddress) => color, e.g. ledger-v9 rawTokenType
  definedKeys, // optional: { 'mip-00xx': [{ key: 'k', valType: 1 }] } — keys a standard defines (none by default)
});
state.apply({ network, contractAddress, block, tx, event, type: 'Misc', name, payload }); // in chain order per network
state.rollbackTo(network, block);  // reorganization: recompute from the remaining canonical events
state.identities();                // [{ network, contractAddress, domainSep, kind, colored, color, fields, common }] — served fields only
state.groups();                    // symbol groups per (network, contractAddress), exact stored bytes
state.display(identity, 123456n);  // { decimals: 2n, text: '1234.56' } — or nulls when there is no usable decimals
state.imageContentAllowed(identity, bytes); // false when a set image_sha256 differs from the content's SHA-256
```

| MIP rule | Implementation |
|---|---|
| Chain order (block, tx, event, record) | `apply` throws `ChainOrderError` on a non-increasing position per network; records apply in order |
| Token identity | `(network, contractAddress from the event record, domainSep, kind)` |
| Latest value wins; marked history (MAY) | `keepHistory: true` keeps replaced values in `history(key, keyHex)` — never current, never a fallback; a Null record drops its own field's history |
| Null record (tombstone) | deletes its own field (value and history; no fallback); a Null record for a field without a value has no effect; a later non-Null record sets the field again and nothing from before returns |
| Keys: serve only the common keys and the keys of standards the token currently declares | every accepted record is stored; views serve the six common keys plus the keys that the standards in the token's current usable `standards` define (`definedKeys`, empty by default). The served keys are computed from the stored fields and the current `standards` whenever a view is built, so a key sent before its standard is declared is served once it is declared, stops being served when the standard is removed, and is served again when it is re-declared. A served key of a standard has `usable` = its value type matches the definition |
| A token identity exists only while one of its fields has a value | when its last field is deleted the identity is removed with all its history: `identities()`, `identity(…)`, `groups()` and `history(…)` do not reference it, as if it had never been described; Null records alone never create one; the next non-Null record describes it again with only that field. An identity whose fields are all unserved keys is not referenced either, until a servable field has a value. To withdraw a token, emit a Null record for each of its keys in one event (`withdrawRecords()` in `@mip0018/codec` for the six common keys) |
| Unusable fields, no defaults | `usable` per common field (`name`/`symbol`: non-empty UTF-8; `decimals`: type 2; `standards`: list format; `image`: URI, type 4; `image_sha256`: type 0, exactly 32 bytes); `common` holds only usable values; no fallback, no default `decimals` |
| `name` 1–64 and `symbol` 1–12 characters | a longer value stays usable and is served (field `value`, `common`, history) as its first 64 / 12 Unicode code points (`servedValue`, `truncateCodePoints`); the stored bytes are kept (`storedValue` when they differ) and grouping compares them |
| `image_sha256` | `imageContentAllowed`: content from `image` is refused when `image_sha256` is set and its SHA-256 differs (a set value that is not 32 bytes matches nothing); without `image_sha256` the content is unchecked and allowed. This package never fetches `image`; render images in a way that cannot run scripts (not as inline SVG) |
| `standards` | `parseStandards`: single-space separated, no byte in 0x00–0x20 or 0x7f; empty = no claims; malformed = unusable |
| Symbol grouping | identities with the same usable `symbol` (the stored bytes) within one `(network, contractAddress)`; deleting a member's `symbol` removes it from its group |
| Display | `formatAmount(raw, decimals)`: exact `bigint` arithmetic for any `decimals` (plain up to 1 000 fractional digits, exact scientific notation beyond; trailing fraction zeros trimmed by default) |
| Reorganizations | every accepted event is retained per network; `rollbackTo` recomputes (or follow finalized blocks only) |
| Color | kinds 1 and 2 only, through the injected `tokenType` hook (kept outside so this package stays dependency-free); never called for kind 3 |

`bin/vector-adapter.js` implements the runner contract (`vectors/README.md`) and is a template for adapters in other
languages:

```sh
node vectors/tools/run.ts --consumer "node packages/consumer/bin/vector-adapter.js"
```

`@mip0018/consumer/internal` exposes rule switches used only by the rule-mutation test (`npm test -w packages/consumer -- mutations`).
