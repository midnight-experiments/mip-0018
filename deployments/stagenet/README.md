# deployments/stagenet

Real cases on Midnight Stagenet (network id `stagenet`, genesis `0x2f76825abc239fecf6107c9df99016de57037b451ae57a4394b76c8cf53a9491`, indexer `https://indexer.stagenet.shielded.tools/api/v4/graphql`, RPC `https://rpc.stagenet.shielded.tools`).

| Case | What | Record |
|---|---|---|
| S0-SPIKE | Toolchain gate: Compact 0.35.0 + ZKIR v3 `SpikeEmitter` deployed, `publishMetadata()` called once (A1 payload), verifier key removed | [`test-contracts/toolchain-spike/records/stagenet.json`](../../test-contracts/toolchain-spike/records/stagenet.json) |

The full case matrix, with one wallet-free re-check command per case, comes with S5.
