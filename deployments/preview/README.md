# deployments/preview — MIP-0018 cases on Midnight preview

The real cases of this repository run on Midnight preview with the `mip0018` CLI. Each folder under
[`cases/`](cases/README.md) states what its case must show before the case's first transaction: `case.json` (one
command per step and the exit code it must end with), `expected.json` and `expect/*.json` (what the reference consumer
and `check-event` must conclude, computed from the examples' `metadata.json` and the vectors by
[`deployments/tools/prepare-cases.ts`](../tools/prepare-cases.ts), never from a chain observation). Running a case
adds its run record (`record.json`: transaction hashes, blocks, fees — public data only, no mnemonic, seed, key or
private state) and its wallet-free observations (`observed-*.json`). Anyone can re-check a case with one wallet-free
command.

## Network

| | |
|---|---|
| Network | Midnight Preview, network id `preview` (profile `preview` of [`packages/midnight`](../../packages/midnight/README.md); constants in [`toolchain.json`](../../toolchain.json) `networks.preview`) |
| Genesis hash | `0x3c096de209e06a1a8c52be7bda109ee8c891a42288c0a9db5495f9616dd13796` |
| Node RPC | `https://rpc.preview.midnight.network` (no token) |
| Indexer | `https://indexer.preview.midnight.network/api/v4/graphql` (no token) |
| Proof server | local: the official `midnightntwrk/proof-server` image pinned in [`toolchain.json`](../../toolchain.json), for contract circuits and the wallet's DUST spends |
| Signers | wallet 1 (deploys and calls in every case) `mn_addr_preview1wlhw0m3nh29lfmk0tj4lvfh2wfsekt8nns9h57gpyfe0az7e9fts2x420z`; wallet 2 (the non-owner of C09) `mn_addr_preview16recat7d5nkh0cxrzllk53x3vstsxmf6xyt7yzgvvh3kpsddz0cqqv7fsw` — test wallets of this repository, registered for DUST |
| Network identity | `network.json`: one observation per check, taken with `node deployments/tools/network-identity.ts --network preview --append deployments/preview/network.json --label <text>` — chain name, node version, runtime, genesis, block 1 (the chain instance) and the finalized head; the first one before the first transaction |

## Running a case

Every case README lists its steps as commands, run in order: the signing steps in `docker/signer.sh` (the wallet
mnemonic mounted read-only), the wallet-free steps in `docker/run.sh`. The [case index](cases/README.md) lists every
case with its expected conclusion and its number of transactions.

## Re-check (wallet-free)

```sh
docker/run.sh mip0018 -- recheck --network preview --case deployments/preview/cases/<ID>
```

`recheck` runs every check the case's `case.json` lists (the recorded transactions with their expected events, the
contract's metadata against `expected.json`, refused steps, removed verifier keys, colors). It verifies the node's
genesis first and, when `network.json` records the chain instance, that the node's block 1 is that block.

## A reset of preview

Preview can be reset to a new chain. The cases then cannot be re-checked on chain: every tool refuses a node whose
genesis or block 1 differs from the one `network.json` records. Their folders keep the expectations, the run records and
the observations, and the cases can be run again on the new chain with the same commands.
