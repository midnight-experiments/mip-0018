# packages/compact — the MIP-0018 Compact module ("what to add to your contract")

Byte-exact MIP-0018 `TokenMetadata` emission in a few lines of Compact, for the pinned MIP text
[`midnightntwrk/midnight-improvement-proposals@338ea194`](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/338ea194bbe7c4e5d1829234a503b7c1b11ebf0f/mips/mip-0018-on-chain-token-metadata.md)
(PR #372). Requires Compact ≥ 0.34.0 (MIP-0002 `Misc` events, ledger v9); built and tested with
**Compact 0.36.0 (language 0.28.0)**.

| File | What |
|---|---|
| [`src/Mip0018.compact`](src/Mip0018.compact) | **Default API** — typed records (`MetadataRecord<#K, #V>`) serialized by Compact (`serialize<[...], 256>`): the compiler checks every size |
| [`src/Mip0018Pure.compact`](src/Mip0018Pure.compact) | **Alternative API** — individual pure circuits returning bytes, composed with `Bytes[...]` spreads; same bytes, no `serialize` |
| [`src/testing/`](src/testing) | `@mip0018/compact/testing`: compile with the pinned compiler and run circuits in compact-runtime 0.21.0, capturing the emitted MIP-0018 events |

Both APIs are built and tested side by side: they emit identical bytes, equal to
the repository's vectors and to `@mip0018/codec`.

## Add it to a contract

```compact
import "@mip0018/compact/src/Mip0018" prefix Mip0018_;  // compile with --compact-path <repo>/node_modules,
                                                        // or import a relative path to src/Mip0018

export circuit publishMetadata(): [] {
  // guard it (owner check), make it publish-once, or remove its key after the first call
  Mip0018_emitPayload(Mip0018_commonFieldsWithStandards<10, 4, 8>(
    domain, Mip0018_KIND_CONTRACT_TOKEN(), "Acme Token", "ACME", 6, "mip-0004"));
}
```

That is MIP test A1 (Appendix A). The generic arguments are the byte lengths of the values
(`"Acme Token"` is `Bytes<10>`); Compact requires them explicitly and checks them. Deploy, then call
`publishMetadata()` right after deployment: **a constructor cannot emit** (compile error), which is
why the MIP names this circuit. Complete contracts: [`examples/minimal`](../../examples/minimal)
(no OpenZeppelin) and [`examples/openzeppelin`](../../examples/openzeppelin).

## API (default module `Mip0018`)

| Circuit | Returns | MIP section |
|---|---|---|
| `EVENT_NAME()` | `pad(32, "mip-0018:token-metadata[v1]")` | Event |
| `KIND_SHIELDED_UTXO()` / `KIND_UNSHIELDED_UTXO()` / `KIND_CONTRACT_TOKEN()` | 1 / 2 / 3 | Token identity and authority |
| `VALTYPE_BYTES()` … `VALTYPE_NULL()` | 0 … 5 | Value types |
| `header(domainSep, kind)` | `MetadataHeader` (asserts kind ∈ {1, 2, 3}) | Payload |
| `bytesRecord<K, V>(key, value)` · `utf8Record` · `jsonRecord` · `uriRecord` | `MetadataRecord<K, V>` with valType 0 / 1 / 3 / 4 | Payload, Value types |
| `uintRecord<K>(key, Uint<8>)` · `uint128Record<K>(key, Uint<128>)` | `MetadataRecord<K, 1>` / `<K, 16>` (little-endian) | Value types |
| `nullRecord<K>(key)` | `MetadataRecord<K, 0>` with valType 5 (tombstone): deletes the field at `key`; the token's other fields stay | Applying records |
| `nameRecord<N>(name)` · `symbolRecord<S>(symbol)` · `decimalsRecord(Uint<8>)` · `standardsRecord<T>(list)` | the common-field records (`name` 1–64 and `symbol` 1–12 characters: consumers show only that many; empty is a compile error) | Common fields |
| `imageRecord<N>(uri)` · `imageSha256Record(hash: Bytes<32>)` | `image` (a URI, valType 4) and `image_sha256` (the SHA-256 of the file at `image`, valType 0, 32 bytes) | Common fields |
| `payload1<K1, V1>(h, r1)` … `payload6<K1, V1, …, K6, V6>(h, r1, …, r6)` | `Bytes<256>`: header ‖ records ‖ zero padding | Payload |
| `commonFields<N, S>(domainSep, kind, name, symbol, decimals)` | `Bytes<256>` | Common fields |
| `commonFieldsWithStandards<N, S, T>(…, standards)` | `Bytes<256>` (Appendix A shape) | Common fields |
| `withdraw(domainSep, kind)` | `Bytes<256>`: ONE event with Null records at the six common keys `name`, `symbol`, `decimals`, `standards`, `image`, `image_sha256` (33-byte header + 62 bytes of records, the rest zero); equals `@mip0018/codec` `withdrawRecords()` | Applying records |
| `emitPayload(payload)` | emits `Misc { EVENT_NAME(), payload }` — the only `emit` (disclosed) | Event, Publishing |

**Deleting metadata** (MIP "Applying records", per-key tombstones): a Null record deletes its own field, and a token
identity exists only while at least one of its fields has a value. `withdraw(domainSep, kind)` withdraws a token
that published only common keys: once all six are deleted (a Null record for a field without a value has no effect),
consumers do not reference the identity at all (not in listings, lookups, groups or history); a later non-Null
record describes it again with only that field. A token that also published keys of a declared standard must add a
Null record for each of them (or the identity stays, with those keys).
To delete a single key, emit one Null record for it, e.g.
`emitPayload(payload1<4, 0>(header(domainSep, kind), nullRecord<4>("name")))`.

`keyLen` and `valLen` are derived from the generic sizes, so they cannot disagree with the data.
Compact has no variadics: `payload1`–`payload6` cover one to six records; a contract that needs more
in one event spreads them itself or sends a second event (MIP "Publishing": group records into as few
events as fit).

The alternative module `Mip0018Pure` has the same names; each record builder takes its own size as an
extra generic argument (`utf8Record<K, V, R>` with `R = 3 + K + V`) and each payload builder its
padding (`payload4<A, B, C, D, P>` with `33 + A + B + C + D + P = 256`; `imageRecord<N, R>` with `R = 8 + N`;
`imageSha256Record` is always 47 bytes), because Compact has no
arithmetic on generic sizes. The compiler checks both. Prefer the default module: it is simpler and
cheaper for runtime values; the alternative exists because it does not rely on `serialize` for
non-event types, which Compact 0.36.0 accepts although its standard-library documentation still says
"can only be instantiated for an event type".

## What the compiler guarantees (and what it cannot)

Static errors (each one a test in [`test/compile-fail.test.ts`](test/compile-fail.test.ts)):
an `emit` in a constructor (directly or through `emitPayload`); an `emit` in a `pure circuit`; an empty
key, `name` or `symbol`; a key or value longer than 255 bytes; records that do not fit in 256 bytes
(a 1-byte key leaves room for a 219-byte value); a value whose length differs from its declared size;
`decimals` above 255; a wrong `R` or `P` in the alternative module; an undisclosed raw `emit`.

Not checked in circuit: that a key or UTF-8 value is valid UTF-8, a JSON value valid JSON, a URI an RFC 3986
URI (scheme required, ASCII), `standards` a well-formed list, or `name`/`symbol` within 64/12 characters. String literals are UTF-8 by
construction; values passed in at run time must be validated off chain before the call (e.g. with
`@mip0018/codec`'s `encodePayload`, which rejects anything a consumer would reject).

## Access control (MIP "Publishing")

Anyone who can call a circuit that reaches `emitPayload` can rename or withdraw the token. Pick one:

1. **Owner-guarded** — OpenZeppelin `Ownable` (`Ownable_assertOnlyOwner()` first), used by the
   OpenZeppelin examples and the raw emitter; or a hand-rolled owner key
   ([`examples/minimal/contracts/OwnerKey.compact`](../../examples/minimal/contracts/OwnerKey.compact)).
2. **Create and destroy** — an unguarded `publishMetadata()` with a **constant** payload, called once
   by the deployer, whose verifier key the maintenance authority then removes with a
   `VerifierKeyRemove` update, after which the circuit cannot be called
   ([`examples/minimal/contracts/CreateAndDestroy.compact`](../../examples/minimal/contracts/CreateAndDestroy.compact),
   tested on the local chain). Caveats: until the key is removed anyone holding the compiled artefacts
   can call the circuit (the deploy does not put the circuit's ZKIR on chain — only its verifier key —
   but the artefacts ship with any DApp), so its payload must be constant: a caller can then only
   re-emit the same values. The contract needs a maintenance authority (midnight-js deploys with
   one), and with ZKIR v3 the key lives in the `v4` slot: midnight-js 5.0.0's
   `circuitMaintenanceTx.<circuit>.removeVerifierKey()` removes it, and so does a `MaintenanceUpdate` with
   `VerifierKeyRemove(circuit, ContractOperationVersion('v4'))` signed by any key of the authority (helper
   [`packages/midnight/src/signer/maintenance.ts`](../midnight/src/signer/maintenance.ts)).
3. **Publish once** — an unguarded constant `publishMetadata()` that sets its own ledger flag
   ([`examples/minimal/contracts/PublishOnce.compact`](../../examples/minimal/contracts/PublishOnce.compact)).
   Keep the flag in your contract; do not reuse OpenZeppelin `Initializable` for it (modules importing
   the same stateful module share its state, LFDT-Minokawa/compact#270).

Never call `emitPayload` from mint, transfer or burn circuits: "Normal token operation … MUST NOT emit
metadata events" (tested: those circuits emit nothing).

## Costs

A constant payload costs only the `emit` (k = 6, 48 rows); any runtime byte (even a `domainSep` read
from the ledger) brings the circuit to k = 15–16 (≈ 30,000–35,000 rows), and four runtime common fields
to k = 16 (≈ 55,000 rows). Full table, proving times and fees: [`docs/costs.md`](../../docs/costs.md).

## Testing harness (`@mip0018/compact/testing`)

```ts
import { ensureCompiled, Simulator } from '@mip0018/compact/testing';

const dir = ensureCompiled('contracts/MyToken.compact', 'managed/MyToken'); // Compact 0.36.0, --skip-zk
const sim = await Simulator.deploy(dir, { args: [domainSep] });
const { misc } = await sim.call('publishMetadata');
// misc[0].name / misc[0].payload: zero-extended to 32 / 256 bytes; misc[0].address: the emitting contract
```

The runtime (like the ledger) trims trailing zero bytes of `name ‖ payload`; `Simulator` zero-extends
to 288 bytes before splitting, as the indexer does (MIP Consuming: missing trailing bytes are zero).

## Tests

```sh
docker/run.sh exec 'npx vitest run packages/compact'
docker/run.sh exec 'npx vitest run packages/compact -t equivalence'
```

| Test | What |
|---|---|
| [`test/vectors.test.ts`](test/vectors.test.ts) | Both modules, executed in compact-runtime 0.21.0: payload = fixture bytes for A1, A2a/b, A3a/b, A4a/b, A5a–c, A6, S1a/b (inputs taken from the fixtures); round trip through the codec; literal A1; `imageRecord`/`imageSha256Record` = A6; `payload6` with the six common-field builders = codec `commonRecords`; `withdraw` = codec `withdrawRecords()` (six Nulls, content ends at 95) and a single-key `nullRecord` = codec `record.tombstone(key)` for kinds 1/2/3; `commonFields` / URI = codec; kind 0, 4, 255 rejected; constants = codec |
| [`test/equivalence.test.ts`](test/equivalence.test.ts) | Generated contracts: every value size 1–219 plus random 2–4-record shapes (uint8, uint128, Null), 3 random inputs each: typed = pure = `@mip0018/codec` `encodePayload` |
| [`test/compile-fail.test.ts`](test/compile-fail.test.ts) | 16 programs the compiler must reject, with the expected message |

Compiled output goes to `managed/` (not committed; keys are deterministic and their SHA-256 are in
[`docs/costs.json`](../../docs/costs.json)).
