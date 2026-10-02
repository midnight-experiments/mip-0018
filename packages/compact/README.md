# packages/compact — the MIP-0018 Compact module ("what to add to your contract")

Byte-exact MIP-0018 `TokenMetadata` emission in a few lines of Compact, for the pinned MIP text
[`midnightntwrk/midnight-improvement-proposals@78ecbb4b`](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/274a84f221bcfc17e4b73e2c8b32fd8c028ea092/mips/mip-0018-on-chain-token-metadata.md)
(PR #340). Requires Compact ≥ 0.34.0 (MIP-0002 `Misc` events, ledger v9); built and tested with
**Compact 0.35.0 (language 0.27.0) and `--feature-zkir-v3`**.

| File | What |
|---|---|
| [`src/Mip0018.compact`](src/Mip0018.compact) | **Default API** — typed records (`MetadataRecord<#K, #V>`) serialized by Compact (`serialize<[...], 256>`): the compiler checks every size |
| [`src/Mip0018Pure.compact`](src/Mip0018Pure.compact) | **Alternative API** — individual pure circuits returning bytes, composed with `Bytes[...]` spreads; same bytes, no `serialize` |
| [`src/testing/`](src/testing) | `@mip0018/compact/testing`: compile with the pinned compiler and run circuits in compact-runtime 0.20.0, capturing the emitted MIP-0018 events |

Both APIs were built and tested side by side (owner decision Q3): they emit identical bytes, equal to
the repository's vectors and to `@mip0018/codec`.

## Add it to a contract

```compact
import "@mip0018/compact/src/Mip0018" prefix Mip0018_;  // compile with --compact-path <repo>/node_modules,
                                                        // or import a relative path to src/Mip0018

export circuit publishMetadata(): [] {
  // guard it (owner check), make it publish-once, or remove its key after the first call
  Mip0018_emitPayload(Mip0018_commonFieldsWithStandards<10, 4, 8>(
    domain, Mip0018_KIND_LEDGER(), "Acme Token", "ACME", 6, "mip-0004"));
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
| `KIND_SHIELDED()` / `KIND_UNSHIELDED()` / `KIND_LEDGER()` | 1 / 2 / 3 | Token identity and authority |
| `VALTYPE_BYTES()` … `VALTYPE_NULL()` | 0 … 5 | Value types |
| `header(domainSep, kind)` | `MetadataHeader` (asserts kind ∈ {1, 2, 3}) | Payload |
| `bytesRecord<K, V>(key, value)` · `utf8Record` · `jsonRecord` · `uriRecord` | `MetadataRecord<K, V>` with valType 0 / 1 / 3 / 4 | Payload, Value types |
| `uintRecord<K>(key, Uint<8>)` · `uint128Record<K>(key, Uint<128>)` | `MetadataRecord<K, 1>` / `<K, 16>` (little-endian) | Value types |
| `nullRecord<K>(key)` | `MetadataRecord<K, 0>` with valType 5 (tombstone) | Applying records |
| `nameRecord<N>(name)` · `symbolRecord<S>(symbol)` · `decimalsRecord(Uint<8>)` · `standardsRecord<T>(list)` | the common-field records | Common fields |
| `payload1<K1, V1>(h, r1)` … `payload4<K1, V1, …, K4, V4>(h, r1, …, r4)` | `Bytes<256>`: header ‖ records ‖ zero padding | Payload |
| `commonFields<N, S>(domainSep, kind, name, symbol, decimals)` | `Bytes<256>` | Common fields |
| `commonFieldsWithStandards<N, S, T>(…, standards)` | `Bytes<256>` (Appendix A shape) | Common fields |
| `tombstone(domainSep, kind)` | `Bytes<256>`: one Null record at key `name` (withdraws the whole identity) | Applying records |
| `emitPayload(payload)` | emits `Misc { EVENT_NAME(), payload }` — the only `emit` (disclosed) | Event, Publishing |

`keyLen` and `valLen` are derived from the generic sizes, so they cannot disagree with the data.
Compact has no variadics: `payload1`–`payload4` cover one to four records; a contract that needs more
in one event spreads them itself or sends a second event (MIP "Publishing": group records into as few
events as fit).

The alternative module `Mip0018Pure` has the same names; each record builder takes its own size as an
extra generic argument (`utf8Record<K, V, R>` with `R = 3 + K + V`) and each payload builder its
padding (`payload4<A, B, C, D, P>` with `33 + A + B + C + D + P = 256`), because Compact has no
arithmetic on generic sizes. The compiler checks both. Prefer the default module: it is simpler and
cheaper for runtime values; the alternative exists because it does not rely on `serialize` for
non-event types, which Compact 0.35.0 accepts although its standard-library documentation still says
"can only be instantiated for an event type".

## What the compiler guarantees (and what it cannot)

Static errors (each one a test in [`test/compile-fail.test.ts`](test/compile-fail.test.ts)):
an `emit` in a constructor (directly or through `emitPayload`); an `emit` in a `pure circuit`; an empty
key, `name` or `symbol`; a key or value longer than 255 bytes; records that do not fit in 256 bytes
(a 1-byte key leaves room for a 219-byte value); a value whose length differs from its declared size;
`decimals` above 255; a wrong `R` or `P` in the alternative module; an undisclosed raw `emit`.

Not checked in circuit: that a UTF-8 value is valid UTF-8, a JSON value valid JSON, a URI an RFC 3986
URI (scheme required, ASCII), or `standards` a well-formed list. String literals are UTF-8 by
construction; values passed in at run time must be validated off chain before the call (e.g. with
`@mip0018/codec`'s `encodePayload`, which rejects anything a consumer would reject).

## Access control (MIP "Publishing", owner decision Q4)

Anyone who can call a circuit that reaches `emitPayload` can rename or withdraw the token. Pick one:

1. **Owner-guarded** — OpenZeppelin `Ownable` (`Ownable_assertOnlyOwner()` first), used by the
   OpenZeppelin examples and the raw emitter; or a hand-rolled owner key
   ([`examples/minimal/contracts/OwnerKey.compact`](../../examples/minimal/contracts/OwnerKey.compact)).
2. **Create and destroy** — an unguarded `publishMetadata()` with a **constant** payload, called once
   by the deployer, whose verifier key the maintenance authority then removes with a
   `VerifierKeyRemove` update: the circuit no longer exists
   ([`examples/minimal/contracts/CreateAndDestroy.compact`](../../examples/minimal/contracts/CreateAndDestroy.compact),
   tested on the local chain and on Stagenet, case [C10](../../deployments/stagenet/cases/C10/README.md)). Caveats: until the key is removed anyone holding the compiled artefacts
   can call the circuit (the deploy does not put the circuit's ZKIR on chain — only its verifier key —
   but the artefacts ship with any DApp), so its payload must be constant: a caller can then only
   re-emit the same values. The contract needs a maintenance authority (midnight-js deploys with
   one), and with ZKIR v3 the key lives in the `v4` slot: midnight-js 5.0.0-rc.2's
   `removeVerifierKey()` removes `v3` only, so build the `MaintenanceUpdate` with
   `VerifierKeyRemove(circuit, ContractOperationVersion('v4'))` (questions Q23; helper
   `test-contracts/toolchain-spike/src/lib/maintenance.ts`).
3. **Publish once** — an unguarded constant `publishMetadata()` that sets its own ledger flag
   ([`examples/minimal/contracts/PublishOnce.compact`](../../examples/minimal/contracts/PublishOnce.compact)).
   Keep the flag in your contract; do not reuse OpenZeppelin `Initializable` for it (modules importing
   the same stateful module share its state, LFDT-Minokawa/compact#270).

Never call `emitPayload` from mint, transfer or burn circuits: "Normal token operation … MUST NOT emit
metadata events" (tested: those circuits emit nothing).

## Costs

A constant payload costs only the `emit` (k = 6, 48 rows); any runtime byte (even a `domainSep` read
from the ledger) brings the circuit to k = 14 (≈ 14,000 rows), and four runtime common fields to
k = 15. Full table, proving times and fees: [`docs/costs.md`](../../docs/costs.md).

## Testing harness (`@mip0018/compact/testing`)

```ts
import { ensureCompiled, Simulator } from '@mip0018/compact/testing';

const dir = ensureCompiled('contracts/MyToken.compact', 'managed/MyToken'); // Compact 0.35.0, ZKIR v3, --skip-zk
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
| [`test/vectors.test.ts`](test/vectors.test.ts) | Both modules, executed in compact-runtime 0.20.0: payload = fixture bytes for A1, A2a/b, A3a–c, A4a/b, A5a–c, S1a/b (inputs taken from the fixtures); round trip through the codec; literal A1; tombstone / `commonFields` / URI = codec; kind 0, 4, 255 rejected; constants = codec |
| [`test/equivalence.test.ts`](test/equivalence.test.ts) | Generated contracts: every value size 1–219 plus random 2–4-record shapes (uint8, uint128, Null), 3 random inputs each: typed = pure = `@mip0018/codec` `encodePayload` |
| [`test/compile-fail.test.ts`](test/compile-fail.test.ts) | 16 programs the compiler must reject, with the expected message |

Compiled output goes to `managed/` (not committed; keys are deterministic and their SHA-256 are in
[`docs/costs.json`](../../docs/costs.json)).
