# deployments/stagenet — real MIP-0018 cases on Midnight Stagenet

Every case below was deployed and emitted on Stagenet with this repository's CLI (`mip0018`), recorded in its folder
(public data only: no mnemonic, seed, key or private state), and can be **re-checked by anyone with one wallet-free
command** against the public endpoints (spec FR-050…FR-053, SC-004, SC-005).

## Network

| | |
|---|---|
| Network | Midnight Stagenet, network id `stagenet` |
| Genesis hash | `0x2f76825abc239fecf6107c9df99016de57037b451ae57a4394b76c8cf53a9491` (`chain_getBlockHash(0)`, checked before the first transaction and again after the matrix) |
| Node | `Midnight Node` `2.0.0-d9729c13`, runtime `midnight` specVersion 2000000, transactionVersion 4 (ledger 9.1.0.0-rc.3) |
| Indexer | `https://indexer.stagenet.shielded.tools/api/v4/graphql` (schema 4.4.0-rc.1, protocolVersion 2000000; ingests finalized blocks only) |
| Node RPC | `https://rpc.stagenet.shielded.tools` |
| Proof servers (local, official images, Q21) | `midnightntwrk/proof-server:9.0.0-rc.8@sha256:2666c7bd…` (contract circuits, ZKIR v3) and `:9.0.0-rc.6@sha256:38a819ea…` (the wallet's DUST spends) — Stagenet has no public prover |
| Toolchain | Compact 0.35.0 `--feature-zkir-v3`, compact-runtime 0.20.0, midnight-js 5.0.0-rc.2, wallet SDK 2.0.0-beta.2 (Q22), ledger-v9 1.0.0-rc.5 ([`toolchain.json`](../../toolchain.json)) |
| Observations | [`network.json`](network.json) — one entry per check (`deployments/stagenet/tools/network-identity.ts`): 2026-10-02 07:54Z finalized 714,397 (before the first transaction), 09:15Z finalized 715,212 (after the matrix) |
| Signers | wallet 1 (issuer/owner) `mn_addr_stagenet1vw57646su9y5z6myarm93m6kcn62j97z0yma94lfkhmta6pz5h5q6utr3k`; wallet 2 (non-owner in C09) `mn_addr_stagenet1vmwmprvxd0m7uet2dtasq24rl2u2xecmkss3x5zndvm9vglea40qqgdz2d` — test wallets of this repository, 5,000 NIGHT each, registered for DUST |
| Date | 2026-10-02 (UTC), matrix blocks 714,495–715,183 |

## Re-check (wallet-free)

```sh
docker/run.sh mip0018 -- recheck --network stagenet --case deployments/stagenet/cases/<ID>
# every case:
for c in C01 C02 C03 C04 C05 C06 C07 C08 C09 C10 IDX; do
  docker/run.sh mip0018 -- recheck --network stagenet --case deployments/stagenet/cases/$c || echo "FAILED $c"
done
```

`recheck` runs every check the case's `case.json` lists: `verify` of each recorded transaction against its
expectation (the indexed event = the raw transaction's `log` op, hash and identifiers recomputed, node block hash,
finality, exact name/payload and accept/reject/ignore with the reason), `list` of the contract against
`expected.json` (C06 also as of each step's block), steps that had to be refused (no transaction), removed verifier
keys, and colors (`tokenType(domainSep, contract)` in the mint scanner's table, in the signer wallet's recorded
balances, and on the live identity). Exit 0 = every check passes; 4 = not yet indexed/final. All cases passed on
2026-10-02, also from a clean checkout in a container without any secret.

## Cases

Expected conclusions were written **before** any transaction, from the vectors and the reference reducer
(`tools/prepare-cases.ts`; never from an observation). Each folder's README has the exact commands, the transaction
table (from its `record.json`) and the re-check command.

| Case | What it shows (what to look at) | Contract | Txs | Blocks | Outcome vs `expected.json` | DUST |
|---|---|---|---:|---|---|---:|
| [S0-SPIKE](../../test-contracts/toolchain-spike/records/stagenet.json) | Toolchain gate: Compact 0.35.0 + ZKIR v3 accepted by Stagenet; A1 published, key removed | `18097aeb608f35d83a65b2cad987084c97c6e9d1dc02973f2a6f6cc2fcdd76e1` | 3 | 710806–710814 | pass (S0; `docker/run.sh spike:check` 15/15) | 1.024 |
| [C01](cases/C01/README.md) | OpenZeppelin `FungibleToken` (kind 3): name/symbol/decimals in one event; no color | `98a90519419e2ebb514b7c6ce87ee7f6f4f9753d9ee6f533c5d1c25b9d437dcf` | 2 | 714495–714501 | **pass** — 1 visible kind-3 identity, 3 usable fields | 7.138 |
| [C02](cases/C02/README.md) | OpenZeppelin `NativeShieldedToken` (kind 1): the minted coin's color = `tokenType(domainSep, contract)` = the identity's color | `0ee5f31961f9df197055c49dda8f87275af50c3554ba701ffa1837537735e532` | 3 | 714551–714564 | **pass** — color `be34ef4b…f11b` held by wallet 1 | 7.066 |
| [C03](cases/C03/README.md) | Native unshielded (kind 2): wallet 1's UTXO token type = the identity's color | `a3df52605d8b7210aa3e5cdc82de4bb2911975bc42c1a68be77044723b705f21` | 3 | 714611–714624 | **pass** — color `8e01e392…8484` | 6.511 |
| [C04](cases/C04/README.md) | One asset as kinds 1, 2, 3 (one publish, three events): one symbol group; kinds 1 and 2 share one color (note N3) | `86acf80ff386abb610aadbea0406039e7fe39893f440794c3c2bad86dd48570f` | 5 | 714637–714663 | **pass** — 3 identities, group "ACD", color `04239924…bc16` for both kinds | 7.758 |
| [C05](cases/C05/README.md) | Token family: three `domainSep` = three identities in one group; bronze published but never minted | `f2d1b6ebfea446cf2624cd498fc585eeb86dddf94e33229ce47107038d2251d6` | 6 | 714677–714712 | **pass** — 3 identities, group "MEDAL", 3 colors | 7.331 |
| [C06](cases/C06/README.md) | Lifecycle on `examples/minimal` OwnerKey: publish (A1 bytes) → rename → tombstone → tombstone again → revive | `9d93b91942530f66f381daf5d9856caf9dfaa24444f0803a6c5d02e8c28040e3` | 6 | 714789–714835 | **pass** — state after every step; final: only name "Acme Again" + symbol "ACMA" | 5.543 |
| [C07](cases/C07/README.md) | Test-only raw emitter: 22 vectors on chain — capacity and edge cases accepted, malformed rejected, other names ignored | `23aa27cbc948fb6df9072750b879e9b7f78206f77c638674a8e01b418ee3355b` | 23 | 714883–715063 | **pass** — 9 accept, 9 reject (each reason), 4 ignore; state = accepted records only | 6.026 |
| [C08](cases/C08/README.md) | Two events in one transaction, one malformed (S7b): independent | `65553c655286664ccb3f69f9313bf725900c46eee2289ae611d18fdf6f90ceb9` | 2 | 715098–715109 | **pass** — event 0 accept ("Good"), event 1 reject (reserved-valtype) | 2.321 |
| [C09](cases/C09/README.md) | Access control: wallet 2 calls C01's owner-only `setMetadata` | (C01's) | 0 | — | **pass** — refused before submission ("Ownable: caller is not the owner"), no transaction; C01 unchanged | 0 |
| [C10](cases/C10/README.md) | Create-and-destroy (Q4): unguarded constant `publishMetadata()` (Appendix A bytes), then `VerifierKeyRemove` | `048ec49aacdde9ef2fee1bd51c651df46d3224578e36a1e89bdbb88842edf0f6` | 3 | 715171–715183 | **pass** — one event = A1; key gone; second publish refused before submission | 2.238 |
| [IDX](cases/IDX/README.md) | Mint scanner from a start height + color lookup (MIP "Lookup", F8), wallet-free | — | 0 | scanned 714485–715183 | **pass** — every minted color of C02–C05 resolves to its contract/domainSep/kind and metadata; bronze "not minted" | 0 |

Matrix C01–C10: **53 transactions, all `SUCCESS`, 51.93 DUST** (fees per transaction in each case README and in
[`docs/costs.md`](../../docs/costs.md#fees-on-stagenet)). Every deployed verifier key equals the SHA-256 the
repository's cost tables list for that circuit (deterministic builds, Q24).

**Mint scanner state** (case IDX): [`cases/IDX/index/index-state.json`](cases/IDX/index/index-state.json), start
height **714485** (the first matrix transaction's block − 10), end 715183; built by
`mip0018 index --network stagenet --from-height 714485 --to-height 715183 --state deployments/stagenet/cases/IDX/index`
(699 blocks over the indexer's `blocks` subscription, 2 HTTP requests + 1 WebSocket). Re-running it reproduces the
table.

## Files in a case folder

| File | What |
|---|---|
| `case.json` | the steps (one `mip0018` command each, with the exit code it must end with), the re-check list |
| `expected.json`, `expect/*.json`, `args/*.json` | the expected consumer state and per-transaction expectations, written before any transaction |
| `record.json` | the run record: contract address, verifier-key SHA-256s, per step the transaction (journaled **before** submission), its inclusion (block, hash, status, fee) and the after-check's observation |
| `observed-verify-<step>.json`, `observed-list*.json` | the `verify` / `list` reports of the run |
| `wallet-status.json` | wallet 1's public balances per token type after the mints (the wallet SDK's own view of the colors) |
| `index/`, `index-summary.json`, `lookup-*.json` | IDX: the scanner's state and the lookups |

## Limitations

- **One operator**: the public indexer and node RPC are run by the same operator (`*.shielded.tools`); `verify`
  cross-checks the indexer against the node (block hash, finality, raw transaction bytes inside the block's
  extrinsics), but both come from that operator.
- **`@beta` APIs**: the indexer's v4 `contractEvents` / `blocks` surfaces and the wallet SDK 2.0.0-beta.2 are
  pre-release; a later schema can change what the commands read (they are isolated in `packages/midnight/src/indexer.ts`).
- **No explorer for contract events**: Stagenet has only the generic polkadot.js explorer (blocks and extrinsics, not
  decoded Midnight transactions or events); the reproducible "link" is the re-check command / an indexer query.
- **Not reproducible on demand**: a reorganization (vector S4) cannot be produced on Stagenet; the commands follow
  finalized blocks only. A Stagenet reset would remove the cases (the records keep the evidence; the genesis hash in
  `network.json` tells whether the chain is the same).
- **The scanner sees everyone's mints**: IDX's table also holds a mint by a contract that is not one of these cases
  (another Stagenet user, block 714802); lookups of the cases' colors are unaffected.
- **Wallet observations are the signer's view**: `wallet-status.json` was written by the signer at the time of the
  case; it is public (addresses and balances) but cannot be re-read without the wallet — `recheck` compares it with
  the colors it recomputes, the scanner's table and the live identity.
