# test-contracts/toolchain-spike — toolchain gate

Proves the pinned toolchain end to end: Compact **0.35.0** with **`--feature-zkir-v3`** compiles, proves and is accepted on the local stack and on Stagenet.

| File | Purpose |
|---|---|
| `contracts/SpikeEmitter.compact` | Smallest emitter: one unguarded `publishMetadata()` that emits the payload of MIP-0018 test A1 (Appendix A), built with Compact's serialization of typed records. Used with create-and-destroy (the deployer calls it once, then removes its verifier key). |
| `contracts/SpikeOzToken.compact` | OpenZeppelin 0.4.0-alpha.5 `Ownable` + `NativeShieldedToken` composed with an owner-only emitting circuit (compile check for language 0.27.0). |
| `scripts/compile.sh` | `docker/run.sh compile:spike` — compiles both and prints `k`/rows per circuit. |
| `src/local.ts` | `spike:local` — deploy, call, check the indexed event equals A1 byte-for-byte, remove the verifier key, check a second call fails (local stack). |
| `src/stagenet.ts`, `scripts/stagenet.sh` | The same on Stagenet in the signer container (no second call). Writes `records/stagenet.json` (public data only). |
| `src/fund.ts` | `docker/local-stack/fund.sh` — funds a local test wallet from the dev genesis wallet and registers it for DUST. |
| `src/lib/` | Thin shims onto `@mip0018/midnight`, which holds the wallet ↔ midnight-js adapter, the chain reads and the `v4` `VerifierKeyRemove` helper; `spike.ts` is the gate's own flow. |
| `mip0018.adapter.ts`, `spike-oz-token.adapter.ts` | `mip0018` CLI adapters: SpikeEmitter (`deploy-and-publish --example toolchain-spike`) and SpikeOzToken (OZ `Ownable` witness `wit_OwnableSK`, owner secret only in the signer's 0600 private state). |

What the gate shows about the pins: two official proof servers are needed (rc.8 reads ZKIR 3.1 circuits; only rc.6 makes DUST-spend proofs node 2.0.0-rc.4 accepts); the wallet SDK rc line cannot sync against indexer 4.4.0-rc.1; midnight-js maintenance updates use the `v3` key slot while ZKIR-v3 keys live in `v4`.

`managed/` (compiler output) is not committed: builds are deterministic, and the verifier-key SHA-256s are recorded in
[`docs/costs.json`](../../docs/costs.json). The Stagenet run is recorded in
[`records/stagenet.json`](records/stagenet.json) (case SPIKE in [`deployments/stagenet`](../../deployments/stagenet/README.md)).
