# examples/publish-and-emit — deploy a token and publish its MIP-0018 metadata with `mip0018`

This walkthrough takes a token that already has the MIP-0018 lines in its contract (the
[OpenZeppelin fungible token](../openzeppelin/fungible-token/README.md) and the
[minimal create-and-destroy contract](../minimal/README.md)), deploys it, publishes its metadata right after the
deployment, renames and withdraws it, and shows create-and-destroy on a local chain; §8 runs the same commands on a
public network, as the preview cases do.
Every command below was run by the local end-to-end test (`packages/cli/test/e2e/examples-e2e.sh`, parts A and B;
it keeps its records under `/e2e/dap/` instead of `/walk/` and adds `--expect` and `--to-block` to some `list` calls);
the outputs are excerpts of that run (2026-11-09 23:53 – 2026-11-10 00:04 UTC, on a fresh local stack), with
`/e2e/dap/` shown as `/walk/`.

What `mip0018` adds to the plain midnight-js calls (shown in the [appendix](#appendix-the-same-with-plain-midnight-js)):
a public **run record** per contract (address, every transaction, written *before* submission), a **before-check**
that skips a step the chain already shows done (no duplicate deploy or publish on a re-run), and an **after-check**
that marks a step completed only when the indexer shows the expected change.

## 1. Local chain and shell set-up

```sh
docker/local-stack/up.sh                       # official midnightntwrk images; random loopback ports ≥ 10000
. docker/local-stack/ports.env                 # MIP0018_STACK_NETWORK, the in-network URLs
WALK="$HOME/mip0018-walkthrough"; mkdir -p "$WALK/records" && mkdir -m 700 -p "$WALK/secrets" "$WALK/state"
NETENV="-e MIP0018_INDEXER_URL=$MIP0018_INDEXER_URL_IN_NETWORK -e MIP0018_NODE_URL=$MIP0018_NODE_URL_IN_NETWORK -v $WALK/records:/walk"

# signing commands: the only container that sees a wallet secret (none here: the local dev wallet is public)
signer() {
  MIP0018_DOCKER_NETWORK="$MIP0018_STACK_NETWORK" MIP0018_SECRET_DIR="$WALK/secrets" MIP0018_STATE_DIR="$WALK/state" \
  MIP0018_DOCKER_ENV="$NETENV -e MIP0018_PROOF_SERVER_URL=$MIP0018_PROOF_SERVER_URL_IN_NETWORK" \
  docker/signer.sh mip0018 -- "$@"
}
# wallet-free commands
mip0018() { MIP0018_DOCKER_NETWORK="$MIP0018_STACK_NETWORK" MIP0018_DOCKER_ENV="$NETENV" docker/run.sh mip0018 -- "$@"; }
A="--network undeployed --dev-genesis-wallet --wallet-cache /run/mip0018/state/a.wallet-cache"
```

`--dev-genesis-wallet` is the local chain's public genesis wallet (refused on any other network). The private state
(the contract's maintenance key, the OpenZeppelin owner secret) goes to `$WALK/state/mip0018-private-state.json`
(mode 0600, outside the repository); the run records in `$WALK/records` are public.

## 2. Compile with keys

The contract already contains the MIP-0018 lines: `publishMetadata()` builds the payload with the typed constructor
of [`packages/compact`](../../packages/compact/README.md) from literals sized exactly to their values
(`Mip0018_commonFields<9, 4>(…, "Acme Gold", "AGLD", FungibleToken__decimals)`). A deploy needs the verifier keys,
so compile without `--skip-zk` (deterministic: the same keys every time):

```sh
docker/run.sh exec 'npm run -s compile -w examples/openzeppelin -- --keys --with-metadata-only fungible-token'
```

`deploy-and-publish` runs exactly this (the adapter's `compile` entry) when `managed/` has no keys.

## 3. Deploy and publish in one command

```sh
signer deploy-and-publish $A --example fungible-token --record /walk/fungible-token.json
```

`--example fungible-token` loads [`examples/openzeppelin/fungible-token/mip0018.adapter.ts`](../openzeppelin/fungible-token/mip0018.adapter.ts):
the OpenZeppelin `Ownable` witnesses (a fresh owner secret, kept only in the private-state file), the constructor
arguments of the example's [`metadata.json`](../openzeppelin/fungible-token/metadata.json), and the calls to make after
the deployment with the exact payload each must emit. The command deploys, calls `publishMetadata()` and checks the
emission wallet-free (the indexer's event = the `log` op of the raw transaction, the node's block, finality, the
exact payload):

```text
network     undeployed  genesis 0x8233…ebae1d  indexer http://indexer:8088/api/v4/graphql
contract    e38964ebb24645d0b291004fab2adf369e60462c10051aba1d453463c32979d6
transaction 1b20a2d0aaf84adc137c1d91bb282a85b7eda45c053b851f5bf262440905e27d  block 29 (5b81de4c…137c9765)  SUCCESS  finalized (finalized head 29)  extrinsic 4
event 0     id 59  segment 25637 (guaranteed)  entry publishMetadata
  result    accept  domainSep 6d69702d303031383a6578616d706c653a66756e6769626c6500000000000000  kind 3 (contract token)
  records   name         "Acme Gold"  type 1
            symbol       "AGLD"  type 1
            decimals     6  type 2
  expected  matches
checks
  OK   identity             node genesis 0x823383ec0302be8417cfcbcc62f21df08f4047bca37aaea89e3f54b550ebae1d (undeployed)
  OK   indexed              transaction 1b20a2d0aaf84adc137c1d91bb282a85b7eda45c053b851f5bf262440905e27d in block 29 (5b81de4cdd89148ab20fb4f27d84ec08b5ed08fbfe84995e0bbc2b15137c9765), SUCCESS
  OK   raw-hash             recomputed hash 1b20a2d0aaf84adc137c1d91bb282a85b7eda45c053b851f5bf262440905e27d
  OK   raw-identifiers      2 identifiers recomputed
  OK   event-0-record       event 59: bound to e38964ebb24645d0b291004fab2adf369e60462c10051aba1d453463c32979d6 (entry point publishMetadata), misc
  OK   event-0-in-raw-tx    event 59: equals a log op of the contract in the raw transaction
  OK   event-0-segment      event 59: its segment applied
  OK   completeness         1 applied Misc log(s) of the contract in the raw transaction, 1 indexed
  OK   node-block-hash      node block 29 = 0x5b81de4cdd89148ab20fb4f27d84ec08b5ed08fbfe84995e0bbc2b15137c9765
  OK   node-extrinsic       raw transaction bytes are extrinsic 4 of block 29
  OK   expect-0             event 59 matches the expectation
  OK   finalized            block 29 ≤ finalized 29
result      ok (exit 0)
record      /walk/fungible-token.json
network     undeployed  genesis 0x8233…ebae1d
contract    MyFungibleToken  e38964ebb24645d0b291004fab2adf369e60462c10051aba1d453463c32979d6
steps
  deploy                             completed  tx 5d961d8b…e4fd8fa0 block 26 SUCCESS fee 4938164564525608 SPECK
  publish                            completed  tx 1b20a2d0…0905e27d block 29 SUCCESS fee 169535109254271 SPECK
```

The fees are in SPECK (10^15 SPECK = 1 DUST): about 4.94 DUST for deploying the token with the verifier keys of all
its circuits, 0.17 DUST for the publish (local chain). On preview the same token cost 10.534 DUST to deploy and
0.219 DUST to publish (case [C01](../../deployments/preview/cases/C01/README.md); all preview fees in
[`docs/costs.md`](../../docs/costs.md#fees-on-preview)).

Re-running the same command changes nothing: every step is already completed on chain. Passing `--metadata` other
than what the contract emits (its values are compiled in) is refused before anything is built.

## 4. Read the record

The record is public JSON (no secret): the contract, the adapter, the SHA-256 of every verifier key it was deployed
with, and per step the transaction — written **before** the node saw it — its inclusion and every check's outcome
(excerpt; long values shortened):

```json
{
  "kind": "mip0018-run-record",
  "network": { "id": "undeployed", "genesisHash": "0x823383ec0302be8417cfcbcc62f21df08f4047bca37aaea89e3f54b550ebae1d", "chainInstance": "0x37241d5f…edcd38ff" },
  "contract": {
    "name": "MyFungibleToken",
    "managedDir": "examples/openzeppelin/fungible-token/managed/MyFungibleToken",
    "adapter": "examples/openzeppelin/fungible-token/mip0018.adapter.ts",
    "address": "e38964ebb24645d0b291004fab2adf369e60462c10051aba1d453463c32979d6",
    "privateStateId": "MyFungibleToken",
    "constructorArgs": ["Acme Gold", "AGLD", 6],
    "verifierKeySha256": { "balanceOf": "1314444ccfea…", "burn": "fd37e5b4c1a4…", "decimals": "3cfdfb97570b…", "…": "…" }
  },
  "steps": [
    {
      "id": "deploy", "kind": "deploy", "state": "completed",
      "tx": { "hash": "5d961d8baca197da2df9337e8cb5eb814cbb71eb6ffe6159855388eee4fd8fa0", "ttl": "2026-11-10T00:25:02.000Z" },
      "inclusion": { "height": 26, "status": "SUCCESS", "fee": "4938164564525608" },
      "attempts": [{ "event": "submitting 5d961d8b…" }, { "event": "node accepted 003f7b01…" }, { "event": "midnight-js: SucceedEntirely at block 26" }, { "event": "completed: contract e38964eb… on chain with balanceOf, burn, …" }]
    },
    {
      "id": "publish", "kind": "call", "circuit": "publishMetadata", "state": "completed",
      "tx": { "hash": "1b20a2d0aaf84adc137c1d91bb282a85b7eda45c053b851f5bf262440905e27d" },
      "inclusion": { "height": 29, "status": "SUCCESS", "fee": "169535109254271" },
      "expectedEvents": [{ "name": "6d69702d303031383a746f6b656e2d6d657461646174615b76315d0000000000", "payload": "6d69702d…" }],
      "attempts": [{ "event": "submitting 1b20a2d0…" }, { "event": "node accepted 00f3a8a1…" }, { "event": "midnight-js: SucceedEntirely at block 29" }, { "event": "completed: 1 expected Misc event(s) observed in 1b20a2d0…" }]
    }
  ]
}
```

The owner secret and the contract's maintenance key are not in it: they are in the 0600 private-state file.

## 5. Check the event and list without a wallet

```sh
mip0018 check-event --network undeployed --record /walk/fungible-token.json --step publish
mip0018 list --network undeployed --record /walk/fungible-token.json --expect @examples/openzeppelin/fungible-token/metadata.json
```

`check-event` prints the same report as above (`result ok (exit 0)`): every record of the event, a key that is not a
common key marked "not served". `list --json` (excerpt):

```text
"snapshot": { "indexerTip": { "height": 29, … }, "toBlock": 29, "tipMatchesNode": true, "finalizedHeight": 29 },
"counts": { "events": 1, "accepted": 1, "rejected": 0, "ignored": 0 },
"identities": [ { "domainSep": "6d69702d303031383a6578616d706c653a66756e6769626c6500000000000000", "kind": 3,
                  "colored": false, "common": { "name": "Acme Gold", "symbol": "AGLD", "decimals": "6" }, … } ],
"expectation": { "ok": true, "differences": [] }
```

`list --expect` compares the reference consumer's state of the contract with the example's expected state (exit 1
and the differences when it does not match). More in [`examples/verify`](../verify/README.md).

## 6. Rename and withdraw

The owner-only circuits take the new values as `Bytes<N>` of the exact sizes compiled into the contract
(`setMetadata(newName: Bytes<9>, newSymbol: Bytes<4>)`); `{"$utf8": …}` must be exactly N bytes — a shorter value is
refused instead of being zero-padded (zero bytes would become part of the value).

```sh
signer publish $A --record /walk/fungible-token.json --circuit setMetadata --args '[{"$utf8":"Acme Bars"},{"$utf8":"ABAR"}]' --step rename
signer publish $A --record /walk/fungible-token.json --circuit withdrawMetadata --step withdraw
signer publish $A --record /walk/fungible-token.json --circuit withdrawMetadata --step withdraw-again --force
signer publish $A --record /walk/fungible-token.json --circuit publishMetadata --step revive
mip0018 list --network undeployed --record /walk/fungible-token.json --history
```

`withdrawMetadata` emits one event with a Null record at each of the six common keys — `name`, `symbol`, `decimals`,
`standards`, `image`, `image_sha256` (`withdraw` in the Compact module): every field is deleted, so consumers do not reference the token at all until a later record
describes it again (MIP "Applying records"). Each `publish` prints the record (the before/after checks in action — the
repeated withdrawal without `--force` is skipped, because it would change nothing):

```text
steps
  deploy                             completed  tx 5d961d8b…e4fd8fa0 block 26 SUCCESS fee 4938164564525608 SPECK
  publish                            completed  tx 1b20a2d0…0905e27d block 29 SUCCESS fee 169535109254271 SPECK
  rename                             completed  tx 68a299b9…d08e4d5f block 96 SUCCESS fee 176634718453921 SPECK
  withdraw                           completed  tx e940b4b7…3a03e28f block 100 SUCCESS fee 177481648090527 SPECK
  withdraw-again-skipped             completed  no tx  (skipped: the contract metadata already holds exactly these values (before-check on the finalized transaction; nothing submitted))
  withdraw-again                     completed  tx e9aaa43f…f6ba4a08 block 105 SUCCESS fee 177471890727911 SPECK
```

(`withdraw-again-skipped` is the same command without `--force`; with `--force` the second withdrawal is emitted, as
case [C06](../../deployments/preview/cases/C06/README.md) does on preview on purpose.) After the revive, `list`:

```text
contract    e38964ebb24645d0b291004fab2adf369e60462c10051aba1d453463c32979d6  network undeployed
snapshot    indexer block 109 (3ec384e9…94f6990f) = node  to-block 109  node finalized 109
events      5 (5 accepted, 0 rejected, 0 ignored) in 2 page(s)
identity  domainSep 6d69702d303031383a6578616d706c653a66756e6769626c6500000000000000  kind 3 (contract token)  color -
  name         "Acme Gold"                              type 1  usable
  symbol       "AGLD"                                   type 1  usable
  decimals     6                                        type 2  usable
  display      1 base unit = 0.000001 AGLD
groups
  "AGLD": 6d69…0000/3
history (replaced values; never current)
source events
  59       block 29       tx 1b20a2d0…0905e27d  accept 6d69…0000/3 (3 record(s))
  90       block 96       tx 68a299b9…d08e4d5f  accept 6d69…0000/3 (2 record(s))
  92       block 100      tx e940b4b7…3a03e28f  accept 6d69…0000/3 (6 record(s))
  94       block 105      tx e9aaa43f…f6ba4a08  accept 6d69…0000/3 (6 record(s))
  96       block 109      tx 298dd74e…12f00a62  accept 6d69…0000/3 (3 record(s))
```

The history is empty: the withdrawal at block 100 deleted every field, so the identity and its history are gone, and
nothing from before it comes back (MIP "Applying records"; vectors S3c, S3d). `list --to-block 96` (after the rename)
shows "Acme Bars"/"ABAR"; at blocks 100 and 105 (after each withdrawal) `list` reports
`identities  none: no token identity of this contract has a field with a value`. The same lifecycle on preview, with
`examples/minimal`'s `OwnerKey`: case [C06](../../deployments/preview/cases/C06/README.md).

## 7. Create and destroy

The minimal [`CreateAndDestroy`](../minimal/contracts/CreateAndDestroy.compact) contract has an unguarded
`publishMetadata()` with a constant payload (MIP Appendix A with the domainSep given at deployment). The deployer
publishes once, then removes the circuit's verifier key with a maintenance `VerifierKeyRemove`; after
that nobody can call it:

```sh
signer deploy-and-publish $A --example minimal --record /walk/minimal.json
signer remove-circuit $A --record /walk/minimal.json --circuit publishMetadata
signer publish $A --record /walk/minimal.json --circuit publishMetadata --step publish-again --force   # exit 1
```

```text
steps
  deploy                             completed  tx 07d933ba…e91739fe block 18 SUCCESS fee 1228716976298232 SPECK
  publish                            completed  tx 4e5f7641…a4d6fcc7 block 22 SUCCESS fee 151695886291523 SPECK
  verifier-key-remove:publishMetadata completed  tx a5013fe8…00bf5163 block 113 SUCCESS fee 115513382769943 SPECK
  publish-again                      pending    no tx
2026-11-10T00:04:07.297Z publish: publish-again: publishMetadata has no verifier key on 203924e8b1a4425fac6a3a1cb1dc3c957313394dde0e7e9965f94992a4e697cb (removed?); nothing submitted
```

The published payload is MIP Appendix A byte-for-byte (the example's domainSep is Appendix A's, `0x11` × 32); `list`
still shows it after the removal. The removal is a maintenance `VerifierKeyRemove` in the `v4` key slot (where ZKIR v3
keys live), signed with the maintenance key midnight-js generated at deployment and the CLI kept in the
private-state file. On preview: case [C10](../../deployments/preview/cases/C10/README.md).

## 8. Public networks

The same commands with `--network preview` (or `preprod` / `mainnet`) and a wallet secret file instead of
`--dev-genesis-wallet`. The secret directory is mounted read-only into the signer container only; the wallet sync cache
(`--wallet-cache`) avoids a several-minute sync per command. `preprod` and `mainnet` are served by Blockfrost: the
project token of that network's Blockfrost project is read from `MIP0018_BLOCKFROST_PREPROD` / `MIP0018_BLOCKFROST_MAINNET`
(or a 0600 file, `--blockfrost-token-file`), passed to the containers by name, and appears in no output or record:

```sh
signer() {
  MIP0018_SECRET_DIR="<0700 directory with the mnemonic file>" MIP0018_STATE_DIR="<0700 state directory outside the repo>" \
  MIP0018_DOCKER_NETWORK="<Docker network of your proof server>" \
  MIP0018_DOCKER_ENV="-e MIP0018_PROOF_SERVER_URL=<proof-server 9.0.1 URL on that network>" \
  docker/signer.sh mip0018 -- "$@"
}
W="--network preview --mnemonic-file /run/mip0018/secrets/<wallet>.mnemonic --wallet-cache /run/mip0018/state/wallet.cache"
signer deploy $W --example fungible-token --record /run/mip0018/state/fungible-token.json
signer publish $W --record /run/mip0018/state/fungible-token.json --circuit publishMetadata --step publish
```

One official proof server (9.0.1) proves the Compact 0.36.0 contract circuits and the wallet's DUST spends. The
recorded preview runs — one `mip0018` command per step — are the case folders
[`deployments/preview/cases/`](../../deployments/preview/cases/README.md):

| Case | What | Contract | Publish transaction |
|---|---|---|---|
| [C01](../../deployments/preview/cases/C01/README.md) | OpenZeppelin fungible token: deploy, publish | `c135766fdc8ef3ae24fcd1e89bd37f66513a9f5948e7d034567de24aaae9237e` | `57f8a00479674d1498b1c2dfa6a3b44f82f6ee822aa8c3c41df6ce1907fb77e7` (block 41547) |
| [C06](../../deployments/preview/cases/C06/README.md) | minimal `OwnerKey`: publish, rename, withdraw (six Null records, one event), withdraw again, revive | `f53dbefbedcf5a5ab992b343e6b4f66585883a929b6a0d277290066268f7ff4a` | `a7c889e8ee0c0de3dfb5c25943922cd8962d5c27d062b1686507c8e8dff20b6c` (block 41728; then rename 41736, withdraw 41744, withdraw again 41752, revive 41760) |
| [C10](../../deployments/preview/cases/C10/README.md) | minimal create-and-destroy | `972122c67324da57729b0f9c9c080d86dc99dc8c1ad0adcce9762b5cb0df9a11` | `cc13881c9191233ad1ff767996278b291842c17c7f37f0e02a5759a9f435e834` (block 42029; key removed in 42035) |

Run on 2026-11-09 with wallet 1 of this repository's test wallets; every case re-checks wallet-free with
`docker/run.sh mip0018 -- recheck --network preview --case deployments/preview/cases/<ID>`. The `preprod` and `mainnet`
profiles are not exercised against live endpoints in this repository (their token handling is tested against a local
stub).

## Appendix: the same with plain midnight-js

[`scripts/midnight-js-snippet.ts`](scripts/midnight-js-snippet.ts) is what `mip0018 deploy-and-publish` does underneath,
without the record and the before/after checks (the wallet checks the node's identity before it opens):
`deployContract` with the owner secret as private state, then `callTx.publishMetadata()` right after the deployment.

The core of it (the providers are built with `@mip0018/midnight/signer` for brevity; any midnight-js
`MidnightProviders` work):

```ts
const compiledContract = await loadCompiledContract({ name, managedDir }, { wit_OwnableSK: secret, wit_FungibleTokenSK: secret });
const secretKey = Uint8Array.from(randomBytes(32)); // the owner's secret: stays in the private state
const ownerId = persistentHash(new CompactTypeVector(1, new CompactTypeBytes(32)), [secretKey]); // OZ Utils.computeAccountId

// 1. deploy — the same literals go to the constructor (getters) and are compiled into publishMetadata()
const deployed = await deployContract(providers, {
  compiledContract,
  privateStateId: name,
  initialPrivateState: { secretKey },
  args: ['Acme Gold', 'AGLD', 6n, { is_left: true, left: ownerId, right: { bytes: new Uint8Array(32) } }],
});
// 2. publish the metadata right after the deployment (Ownable: only the deployer's secret passes)
const published = await deployed.callTx.publishMetadata();
```

Run on the local chain (2026-11-10), then checked wallet-free with the expected payload from `metadata.json`:

```sh
MIP0018_DOCKER_NETWORK=$MIP0018_STACK_NETWORK MIP0018_DOCKER_ENV="-e MIP0018_INDEXER_URL=$MIP0018_INDEXER_URL_IN_NETWORK \
  -e MIP0018_NODE_URL=$MIP0018_NODE_URL_IN_NETWORK -e MIP0018_PROOF_SERVER_URL=$MIP0018_PROOF_SERVER_URL_IN_NETWORK" \
  docker/run.sh exec 'node examples/publish-and-emit/scripts/midnight-js-snippet.ts'
```

```text
{"contract":"cd175030f9add2de29cde76439872e90738a2189fa2e7599c2a867a56b9db2cf","deploy":{"tx":"dd965b1acd4841afdd4839d49c746c4204626040380b546b33a2f533f97db331","block":128},"publish":{"tx":"bc6dbe1816d5b087f0160ed67ed70e538c7e488781b6a531a3543ffa2e9b1fe4","block":131,"status":"SucceedEntirely"}}

$ mip0018 check-event --network undeployed --contract cd175030…6b9db2cf --tx bc6dbe18…2e9b1fe4 --expect '{"payload":"6d69702d…","result":"accept"}'
  result    accept  domainSep 6d69702d303031383a6578616d706c653a66756e6769626c6500000000000000  kind 3 (contract token)
  records   name         "Acme Gold"  type 1
            symbol       "AGLD"  type 1
            decimals     6  type 2
  expected  matches
result      ok (exit 0)
```

What the snippet does not do, and the CLI does: record the transaction before submission (a crash after submitting
leaves no trace here, and a blind re-run deploys a second contract), skip what the chain already shows, and confirm the
expected events through the indexer before calling a step done.
