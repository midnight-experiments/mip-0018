# deployments/preview — MIP-0018 cases on Midnight preview

The real cases of this repository run on Midnight preview with the `mip0018` CLI. Each folder under
[`cases/`](cases/README.md) states what its case must show before the case's first transaction: `case.json` (one
command per step and the exit code it must end with), `expected.json` and `expect/*.json` (what the reference consumer
and `check-event` must conclude, computed from the examples' `metadata.json` and the vectors by
[`deployments/tools/prepare-cases.ts`](../tools/prepare-cases.ts), never from a chain observation). Running a case
adds its run record (`record.json`: transaction hashes, blocks, fees — public data only, no mnemonic, seed, key or
private state) and its wallet-free observations (`observed-*.json`). Anyone can re-check a case with one wallet-free
command, without a wallet, an account or a token.

## Network

| | |
|---|---|
| Network | Midnight Preview, network id `preview` (profile `preview` of [`packages/midnight`](../../packages/midnight/README.md); constants in [`toolchain.json`](../../toolchain.json) `networks.preview`) |
| Genesis hash | `0x3c096de209e06a1a8c52be7bda109ee8c891a42288c0a9db5495f9616dd13796` |
| Chain instance (block 1) | `0xee45046d11882c45ee0d468203169afa48f084ffaa380043ab84b1fabf3947fe` |
| Node | `Midnight Node` `2.1.101-913ec011`, runtime `midnight` specVersion 2001100, transactionVersion 4 |
| Node RPC | `https://rpc.preview.midnight.network` (no token) |
| Indexer | `https://indexer.preview.midnight.network/api/v4/graphql` (no token; protocolVersion 2001100) |
| Proof server | local: the official `midnightntwrk/proof-server` 9.0.1 image pinned in [`toolchain.json`](../../toolchain.json), one for contract circuits and the wallet's DUST spends |
| Toolchain | Compact 0.36.0, compact-runtime 0.21.0, midnight-js 5.0.0, wallet SDK 2.0.0, `ledger-v9` 1.0.1 ([`toolchain.json`](../../toolchain.json)) |
| Signers | wallet 1 (deploys and calls in every case) `mn_addr_preview1wlhw0m3nh29lfmk0tj4lvfh2wfsekt8nns9h57gpyfe0az7e9fts2x420z`; wallet 2 (the non-owner of C09) `mn_addr_preview16recat7d5nkh0cxrzllk53x3vstsxmf6xyt7yzgvvh3kpsddz0cqqv7fsw` — test wallets of this repository, 5,000 NIGHT each, registered for DUST |
| Network identity | [`network.json`](network.json): one observation per check, taken with `node deployments/tools/network-identity.ts --network preview --append deployments/preview/network.json --label <text>` — chain name, node version, runtime, genesis, block 1 (the chain instance), the finalized head and the proof server. 2026-11-09 22:18Z "before the first transaction": finalized 41,528; 23:39Z "after the last transaction": finalized 42,341 — same genesis, chain instance, node build and runtime both times |
| Date | 2026-11-09 (UTC): matrix blocks 41,541–42,095, upgrade case U1 42,130–42,153 |

## Running a case

Every case README lists its steps as commands, run in order: the signing steps in `docker/signer.sh` (the wallet
mnemonic mounted read-only), the wallet-free steps in `docker/run.sh`. The [case index](cases/README.md) lists every
case with its expected conclusion and its number of transactions. The cases run in the order of the table below, one
transaction in flight at a time: C09 needs C01's contract, C12 emits on C07's contract after C07's last step, IDX scans
the blocks of C01–C12, and U1 keeps its own scan range.

## Re-check (wallet-free)

```sh
docker/run.sh mip0018 -- recheck --network preview --case deployments/preview/cases/<ID>
# every case:
for c in C01 C02 C03 C04 C05 C06 C07 C08 C09 C10 C12 IDX U1; do
  docker/run.sh mip0018 -- recheck --network preview --case deployments/preview/cases/$c || echo "FAILED $c"
done
```

`recheck` runs every check the case's `case.json` lists: `check-event` of each recorded transaction against its
expectation (the indexed event = the raw transaction's `log` op, hash and identifiers recomputed, node block hash,
finality, exact name/payload and accept/reject/ignore with the reason), `list` of the contract against
`expected.json` (C06 and C12 also as of each step's block; C07 as of its last step, since C12 shares its contract),
steps that had to be refused (no transaction), removed verifier keys, and colors (`tokenType(domainSep, contract)` in
the mint scanner's table, in the signer wallet's recorded balances, and on the live identity). It verifies the node's
genesis first and that the node's block 1 is the chain instance `network.json` records. Exit 0 = every check passes;
4 = not yet indexed or final. It needs no secret: it runs from a clean checkout in a container that holds no wallet
material. The `list` check compares the reference consumer's own state with `expected.json` strictly (single-member
groups and every field included), so it is stricter than the vector runner's S9 rule. The 13 cases hold 84 checks:
C01 2, C02 3, C03 3, C04 4, C05 6, C06 11, C07 23, C08 2, C09 2, C10 4, C12 13, IDX 7, U1 4.

## Cases

Expected conclusions come from each case's definition: consumer states are computed from the examples'
`metadata.json` and the vectors with the reference consumer, never from a chain observation. Each folder's README has
the exact commands, the transaction table (from its `record.json`) and the re-check command.

| Case | What it shows (what to look at) | Contract | Txs | Blocks | Outcome vs `expected.json` | DUST |
|---|---|---|---:|---|---|---:|
| [C01](cases/C01/README.md) | OpenZeppelin `FungibleToken` (kind 3): name/symbol/decimals in one event; no color | `c135766fdc8ef3ae24fcd1e89bd37f66513a9f5948e7d034567de24aaae9237e` | 2 | 41541–41547 | **pass** — 1 kind-3 identity, 3 usable fields | 10.753 |
| [C02](cases/C02/README.md) | OpenZeppelin `NativeShieldedToken` (kind 1): the minted coin's color = `tokenType(domainSep, contract)` = the identity's color | `fcfcb1d1d49257649fba11fffaa8c16858dd057485c13954b6f868a942bbfc02` | 3 | 41563–41576 | **pass** — color `6899f7c7…26d8` held by wallet 1 | 10.333 |
| [C03](cases/C03/README.md) | Native unshielded (kind 2): wallet 1's UTXO token type = the identity's color | `f6e2fac7659ec945494ceaed8c17c5f6cc88af9e6d7f83c9f88f6c9f33b42a1c` | 3 | 41594–41612 | **pass** — color `651ab6b0…77d0` | 9.269 |
| [C04](cases/C04/README.md) | One asset as kinds 1, 2, 3 (one publish, three events): one symbol group; kinds 1 and 2 share one color (MIP Lookup) | `63d973a7df1b383cca57d8fab9c2a2ee3fa08bc92baada5dc3f12863ad1bfe93` | 5 | 41629–41655 | **pass** — 3 identities, group "ACD", color `056c310e…1b2a` for both kinds | 10.742 |
| [C05](cases/C05/README.md) | Token family: three `domainSep` = three identities in one group; bronze published but never minted | `93500811da5365b6a83ffe00b3f2d74bfbd0cd8bcaa124024578095b9854394e` | 6 | 41672–41704 | **pass** — 3 identities, group "MEDAL", 3 colors | 9.930 |
| [C06](cases/C06/README.md) | Lifecycle on `examples/minimal` `OwnerKey`: publish (Appendix A bytes) → rename → withdraw (one event, a Null record at each of the six common keys) → the same again → revive | `f53dbefbedcf5a5ab992b343e6b4f66585883a929b6a0d277290066268f7ff4a` | 6 | 41722–41760 | **pass** — state after every step; after each withdrawal no identity and no group; final: ONLY name "Acme Again" + symbol "ACMA" | 7.406 |
| [C07](cases/C07/README.md) | Test-only raw emitter: 22 vector events on chain — capacity and edge cases accepted, malformed rejected (step `A3c`: vector `R5i`, a key that is not valid UTF-8), other names ignored | `cd2fd7655fd4481daa50ea0e7ed7095247dd7f15c48d746116a2fa6e02fdb6a9` | 23 | 41777–41952 | **pass** — 8 accept, 10 reject (each reason), 4 ignore; served state = the common keys the accepted records set (name, symbol, decimals) | 7.648 |
| [C08](cases/C08/README.md) | Two events in one transaction, one malformed (S7b): independent | `252964661b893845299864a5f83b75d5bd2b6d6019a59d0befb6a3ba34a210fd` | 2 | 41983–41993 | **pass** — event 0 accept ("Good"), event 1 reject (reserved-valtype) | 3.059 |
| [C09](cases/C09/README.md) | Access control: wallet 2 calls C01's owner-only `setMetadata` | (C01's) | 0 | — | **pass** — refused before submission ("Ownable: caller is not the owner"), no transaction; C01 unchanged | 0 |
| [C10](cases/C10/README.md) | Create-and-destroy: unguarded constant `publishMetadata()` (Appendix A bytes), then `VerifierKeyRemove` | `972122c67324da57729b0f9c9c080d86dc99dc8c1ad0adcce9762b5cb0df9a11` | 3 | 42023–42035 | **pass** — one event = A1; key gone; second publish refused before submission | 3.025 |
| [C12](cases/C12/README.md) | Test-only raw emitter (C07's contract): `image` + `image_sha256` (A6), `foo = "x"` not served (S10a), a 70-character name and a 15-character symbol served truncated (S11), a 31-byte `image_sha256` unusable (S12b); then vector S3a's two kind-1 events: publish, then a Null record that deletes `name` only | `cd2fd7655fd4481daa50ea0e7ed7095247dd7f15c48d746116a2fa6e02fdb6a9` (C07's) | 6 | 42054–42095 | **pass** — state after every step; after the delete the kind-1 identity keeps symbol "GLD", decimals 6, standards "mip-0011" without `name`; C07's identity unchanged next to them | 1.315 |
| [IDX](cases/IDX/README.md) | Mint scanner from a start height + color lookup (MIP "Lookup"), wallet-free | — | 0 | scanned 41531–42095 | **pass** — every minted color of C02–C05 resolves to its contract/domainSep/kind and metadata; bronze "not minted" | 0 |
| [U1](cases/U1/README.md) | Existing-contract upgrade (MIP "Existing contracts"): a token deployed WITHOUT an emitting circuit gets `publishMetadata()` by a maintenance `VerifierKeyInsert` | `783fd16b82e6ce98381bf7a19d458f8bb179b6612984ef6f64c5cfbf2eab453a` | 4 | 42130–42153 | **pass** — same address; ledger data unchanged; the pre-upgrade coins' color `110b4cf8…704a` = the identity's color; scanner + lookup; an insert signed by a key outside the committee refused, the forced one rejected by the node (`Custom error: 135`) | 3.560 |

All 13 cases: **63 included transactions, all `SUCCESS`, 77.040 DUST** (77,039,598,874,026,371 SPECK, the sum of the
indexer's `fee` in the records). Matrix C01–C10 and C12: 59 transactions, 73.480 DUST; U1: 4 transactions, 3.560 DUST.
U1's forced insert signed by a key outside the committee was rejected by the node at submission (`1010: Invalid
Transaction: Custom error: 135`): not included, no fee. Fees per transaction in each case README and in
[`docs/costs.md`](../../docs/costs.md#fees-on-preview).

Builds are deterministic: every verifier key a case deployed equals, byte for byte, the SHA-256 in the cost tables
([`docs/costs.json`](../../docs/costs.json), [`examples/openzeppelin/costs.json`](../../examples/openzeppelin/costs.json));
`LegacyToken.mint` and the `publishMetadata` key U1 inserted equal the upgrade template's local build
(`b1dbe2b7…e53d`, `fd630482…e1fc`).

**Mint scanner state** (case IDX): [`cases/IDX/index/index-state.json`](cases/IDX/index/index-state.json), start
height **41531** (the first matrix transaction's block − 10), end 42095 (the last matrix transaction's block); built by
`mip0018 index --network preview --from-height 41531 --to-height 42095 --state deployments/preview/cases/IDX/index`
(565 blocks over the indexer's `blocks` subscription, 2 HTTP requests + 1 WebSocket; 75 transactions, 50 contract
calls, 9 deploys, 6 mints, 41 MIP-0018 events, 0 decode errors). Re-running it reproduces the table. The upgrade case
keeps its own scan: [`cases/U1/index/index-state.json`](cases/U1/index/index-state.json), start height **42129** (U1's
deploy block − 1), end 42153 — the pre-upgrade mint (42136) precedes the `VerifierKeyInsert` (42148).

## Files in a case folder

| File | What |
|---|---|
| `case.json` | the steps (one `mip0018` command each, with the exit code it must end with), the re-check list |
| `expected.json`, `expected-after-*.json`, `expect/*.json`, `args/*.json` | the expected consumer state (after the case and after each step) and per-transaction expectations, computed from the case definition |
| `record.json` | the run record: contract address, verifier-key SHA-256s, per step the transaction (journaled **before** submission), its inclusion (block, hash, status, fee) and the after-check's observation |
| `observed-check-event-<step>.json`, `observed-list*.json` | the wallet-free `check-event` report of each transaction and the `list` report of the contract (C06, C07, C12: as of each step's block) |
| `wallet-status*.json` | wallet 1's public balances per token type after the mints (C02–C05, U1: the wallet SDK's own view of the colors) |
| `index/`, `index-summary.json`, `lookup*.json` | IDX and U1: the scanner's state and the lookups |
| `observed-inspect-*.json` | U1: the contract's entry points, maintenance committee and ledger data before and after the upgrade |

## Limitations

- **One operator**: the public indexer and node RPC are run by the same operator (`*.preview.midnight.network`);
  `check-event` cross-checks the indexer against the node (block hash, finality, raw transaction bytes inside the
  block's extrinsics), but both come from that operator.
- **`@beta` APIs**: the indexer's v4 `contractEvents` / `blocks` surfaces are marked `@beta` in its schema; a later
  schema can change what the commands read (they are isolated in `packages/midnight/src/indexer.ts`).
- **The link to a case is its re-check command** (or an indexer query): the case READMEs give every transaction hash
  and block.
- **Not reproducible on demand**: a reorganization (vector S4) cannot be produced on preview; the commands follow
  finalized blocks only.
- **A reset of preview** removes the chain the cases ran on (see below).
- **The scanner sees everyone's mints**: IDX's range holds only the cases' mints (5 colors); a scan of another range
  lists other contracts' mints too, and lookups of the cases' colors are unaffected by them.
- **Wallet observations are the signer's view**: `wallet-status*.json` was written by the signer at the time of the
  case; it is public (addresses and balances) but cannot be re-read without the wallet — `recheck` compares it with
  the colors it recomputes, the scanner's table and the live identity.
- **Fees are preview's at the time of the run**: the network's fee parameters set them; another run can differ.

## A reset of preview

Preview can be reset to a new chain. The cases then cannot be re-checked on chain: every tool refuses a node whose
genesis or block 1 differs from the one `network.json` records. Their folders keep the expectations, the run records and
the observations, and the cases can be run again on the new chain with the same commands.
