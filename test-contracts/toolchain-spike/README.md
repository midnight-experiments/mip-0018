# test-contracts/toolchain-spike — toolchain gate

Proves the pinned toolchain end to end: Compact **0.36.0** compiles, proves and is accepted on the local stack and on Stagenet.

| File | Purpose |
|---|---|
| `contracts/SpikeEmitter.compact` | Smallest emitter: one unguarded `publishMetadata()` that emits the payload of MIP-0018 test A1 (Appendix A), built with Compact's serialization of typed records. Used with create-and-destroy (the deployer calls it once, then removes its verifier key). |
| `contracts/SpikeOzToken.compact` | OpenZeppelin 0.5.0-alpha.2 `Ownable` + `NativeShieldedToken` composed with an owner-only emitting circuit (compile check for language 0.28.0). |
| `scripts/compile.sh` | `docker/run.sh compile:spike` — compiles both and prints `k`/rows per circuit. |
| `src/local.ts` | `spike:local` — deploy, call, check the indexed event equals A1 byte-for-byte, remove the verifier key, check a second call fails (local stack). |
| `src/stagenet.ts`, `scripts/stagenet.sh` | The same on Stagenet in the signer container (no second call). Writes `records/stagenet.json` (public data only). |
| `src/fund.ts` | `docker/local-stack/fund.sh` — funds a local test wallet from the dev genesis wallet and registers it for DUST. |
| `src/lib/` | Thin shims onto `@mip0018/midnight`, which holds the wallet ↔ midnight-js adapter, the chain reads and the `v4` `VerifierKeyRemove` helper; `spike.ts` is the gate's own flow. |
| `mip0018.adapter.ts`, `spike-oz-token.adapter.ts` | `mip0018` CLI adapters: SpikeEmitter (`deploy-and-publish --example toolchain-spike`) and SpikeOzToken (OZ `Ownable` witness `wit_OwnableSK`, owner secret only in the signer's 0600 private state). |

What the gate shows about the pins: one official proof server (9.0.1) proves the contract circuits and the wallet's DUST spends; wallet SDK 2.0.0 syncs against indexer 4.4.101; midnight-js 5.0.0's `circuitMaintenanceTx` removes a ZKIR-v3 key from the `v4` slot (`spike:local`), as the package's signed `MaintenanceUpdate` does.

`managed/` (compiler output) is not committed: builds are deterministic, and the verifier-key SHA-256s are recorded in
[`docs/costs.json`](../../docs/costs.json). The Stagenet run is recorded in
[`records/stagenet.json`](records/stagenet.json) (case SPIKE in [`deployments/stagenet`](../../deployments/stagenet/README.md)).
