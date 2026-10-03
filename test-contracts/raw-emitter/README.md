# test-contracts/raw-emitter — TEST ONLY, NOT FOR PRODUCTION

> **Never use this contract as an example or in a token.** It emits any `Misc` name and payload it is
> given, unchecked. Issuers use [`packages/compact`](../../packages/compact), which can only build
> valid MIP-0018 payloads.

Purpose: put events on a test network that a conforming MIP-0018 consumer must **reject** (malformed
payloads, MIP tests R1–R6), **ignore** (`mip-0018:token-metadata[v2]` and foreign names) or accept at
**capacity** (A2), next to valid ones, and two events in **one transaction** (MIP test S7). Used by the
Stagenet cases [C07](../../deployments/stagenet/cases/C07/README.md) (22 vectors) and
[C08](../../deployments/stagenet/cases/C08/README.md) (S7b).

| Circuit | Who | Emits |
|---|---|---|
| `emitRaw(name: Bytes<32>, payload: Bytes<256>)` | owner | `Misc { name, payload }` exactly as given |
| `emitTwo(name1, payload1, name2, payload2)` | owner | two `Misc` events, in this order, in one call |
| `accountId(secretKey)` (pure) | anyone | the OpenZeppelin account id `persistentHash(secretKey)` |

Access control: OpenZeppelin Compact Contracts `0.4.0-alpha.5` `Ownable`. The
constructor takes `initialOwner: Either<Bytes<32>, ContractAddress>` = `left(accountId(secretKey))`;
the caller proves ownership through the `wit_OwnableSK` witness (private state `{ ownableSecretKey }`,
see `src/contract.ts`).

```sh
docker/run.sh exec 'npm run -w test-contracts/raw-emitter compile'            # --skip-zk
docker/run.sh exec 'npm run -w test-contracts/raw-emitter compile -- --keys'  # prover/verifier keys
docker/run.sh exec 'npx vitest run test-contracts/raw-emitter'
```

Tests (`test/raw-emitter.test.ts`, compact-runtime 0.20.0): the owner emits A1, A2a/b, R1–R6 and
I1/I2 vectors byte-for-byte and `@mip0018/codec` classifies each as the vector says; `emitTwo` emits a
malformed then a valid event (S7); a non-owner call fails with `Ownable: caller is not the owner` and
emits nothing. Note what the wire does: trailing zero bytes of `name ‖ payload` are trimmed, content
or padding alike (A2a travels as 286 bytes because its last two content bytes, `valType` and
`valLen`, are zero) — consumers zero-extend to 288 bytes (MIP Consuming: missing trailing bytes are zero).

Costs (k, rows, keys): [`docs/costs.md`](../../docs/costs.md).
