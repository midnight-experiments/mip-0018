# examples/publish-and-emit — deploy a token and publish its MIP-0018 metadata with `mip0018`

This walkthrough takes a token that already has the MIP-0018 lines in its contract (the
[OpenZeppelin fungible token](../openzeppelin/fungible-token/README.md) and the
[minimal create-and-destroy contract](../minimal/README.md)), deploys it, publishes its metadata right after the
deployment, renames and withdraws it, and shows create-and-destroy on a local chain; §8 runs the same commands on a
public network.
Every command below was run by the local end-to-end test (`packages/cli/test/e2e/examples-e2e.sh`, parts A and B;
it keeps its records under `/e2e/dap/` instead of `/walk/` and adds `--expect` and `--to-block` to some `list` calls);
the outputs are excerpts of that run (2026-10-07), with `/e2e/dap/` shown as `/walk/`.

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
network     undeployed  genesis 0x6356…56356a  indexer http://indexer:8088/api/v4/graphql
contract    787ce186ec75dc471d7c44ac7e64d423cad0a05d3bdb5393c2ae59b0c4fed602
transaction f604562c064fa16d5ef3720bec8b966d3c21999817a7764d6215f3a6a371610f  block 34 (2791c917…2c85fd82)  SUCCESS  finalized (finalized head 35)  extrinsic 4
event 0     id 59  segment 1065 (guaranteed)  entry publishMetadata
  result    accept  domainSep 6d69702d303031383a6578616d706c653a66756e6769626c6500000000000000  kind 3 (contract token)
  records   name         "Acme Gold"  type 1
            symbol       "AGLD"  type 1
            decimals     6  type 2
  expected  matches
checks
  OK   identity             node genesis 0x635663c02847be53aacef6ba8e6153d6a6ff81e8f8be51dcc92d40fca056356a (undeployed)
  OK   indexed              transaction f604562c064fa16d5ef3720bec8b966d3c21999817a7764d6215f3a6a371610f in block 34 (2791c917b535e12a8b1d0c6232ad483076b924ec07a0efac1e4f7f192c85fd82), SUCCESS
  OK   raw-hash             recomputed hash f604562c064fa16d5ef3720bec8b966d3c21999817a7764d6215f3a6a371610f
  OK   raw-identifiers      2 identifiers recomputed
  OK   event-0-record       event 59: bound to 787ce186ec75dc471d7c44ac7e64d423cad0a05d3bdb5393c2ae59b0c4fed602 (entry point publishMetadata), misc
  OK   event-0-in-raw-tx    event 59: equals a log op of the contract in the raw transaction
  OK   event-0-segment      event 59: its segment applied
  OK   completeness         1 applied Misc log(s) of the contract in the raw transaction, 1 indexed
  OK   node-block-hash      node block 34 = 0x2791c917b535e12a8b1d0c6232ad483076b924ec07a0efac1e4f7f192c85fd82
  OK   node-extrinsic       raw transaction bytes are extrinsic 4 of block 34
  OK   expect-0             event 59 matches the expectation
  OK   finalized            block 34 ≤ finalized 35
result      ok (exit 0)
record      /walk/fungible-token.json
network     undeployed  genesis 0x6356…56356a
contract    MyFungibleToken  787ce186ec75dc471d7c44ac7e64d423cad0a05d3bdb5393c2ae59b0c4fed602
steps
  deploy                             completed  tx c285fe0d…82fa1d32 block 30 SUCCESS fee 4938164564525608 SPECK
  publish                            completed  tx f604562c…a371610f block 34 SUCCESS fee 164017660288561 SPECK
```

The fees are in SPECK (10^15 SPECK = 1 DUST): about 4.94 DUST for deploying the token with the verifier keys of all
its circuits, 0.16 DUST for the publish (local chain).

Re-running the same command changes nothing: every step is already completed on chain. Passing `--metadata` other
than what the contract emits (its values are compiled in) is refused before anything is built.

## 4. Read the record

The record is public JSON (no secret): the contract, the adapter, the SHA-256 of every verifier key it was deployed
with, and per step the transaction — written **before** the node saw it — its inclusion and every check's outcome
(excerpt; long values shortened):

```json
{
  "kind": "mip0018-run-record",
  "network": { "id": "undeployed", "genesisHash": "0x635663c02847be53aacef6ba8e6153d6a6ff81e8f8be51dcc92d40fca056356a" },
  "contract": {
    "name": "MyFungibleToken",
    "managedDir": "examples/openzeppelin/fungible-token/managed/MyFungibleToken",
    "adapter": "examples/openzeppelin/fungible-token/mip0018.adapter.ts",
    "address": "787ce186ec75dc471d7c44ac7e64d423cad0a05d3bdb5393c2ae59b0c4fed602",
    "privateStateId": "MyFungibleToken",
    "constructorArgs": ["Acme Gold", "AGLD", 6],
    "verifierKeySha256": { "balanceOf": "1314444ccfea…", "burn": "fd37e5b4c1a4…", "decimals": "3cfdfb97570b…", "…": "…" }
  },
  "steps": [
    {
      "id": "deploy", "kind": "deploy", "state": "completed",
      "tx": { "hash": "c285fe0db58803256df6f76150eb563c9e6e4f95640f72d120a4947a82fa1d32", "ttl": "2026-10-07T20:44:31.000Z" },
      "inclusion": { "height": 30, "status": "SUCCESS", "fee": "4938164564525608" },
      "attempts": ["submitting c285fe0d…", "node accepted 005e2e69…", "midnight-js: SucceedEntirely at block 30", "completed: contract 787ce186… on chain with …"]
    },
    {
      "id": "publish", "kind": "call", "circuit": "publishMetadata", "state": "completed",
      "tx": { "hash": "f604562c064fa16d5ef3720bec8b966d3c21999817a7764d6215f3a6a371610f" },
      "inclusion": { "height": 34, "status": "SUCCESS", "fee": "164017660288561" },
      "expectedEvents": [{ "name": "6d69702d303031383a746f6b656e2d6d657461646174615b76315d0000000000", "payload": "6d69702d…" }],
      "attempts": ["submitting f604562c…", "node accepted 005a99b3…", "midnight-js: SucceedEntirely at block 34", "completed: 1 expected Misc event(s) observed in f604562c…"]
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
"snapshot": { "indexerTip": { "height": 36, … }, "toBlock": 36, "tipMatchesNode": true, "finalizedHeight": 36 },
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
  deploy                             completed  tx c285fe0d…82fa1d32 block 30 SUCCESS fee 4938164564525608 SPECK
  publish                            completed  tx f604562c…a371610f block 34 SUCCESS fee 164017660288561 SPECK
  rename                             completed  tx 761ed938…5d531f75 block 118 SUCCESS fee 170666688769564 SPECK
  withdraw                           completed  tx e54dd47a…69f06d6d block 123 SUCCESS fee 171037094324210 SPECK
  withdraw-again-skipped             completed  no tx  (skipped: the contract metadata already holds exactly these values (before-check on the finalized transaction; nothing submitted))
```

(`withdraw-again-skipped` is the same command without `--force`; with `--force` the second withdrawal is emitted.) After the revive, `list`:

```text
contract    787ce186ec75dc471d7c44ac7e64d423cad0a05d3bdb5393c2ae59b0c4fed602  network undeployed
snapshot    indexer block 135 (5ed433fb…1ec6b2d6) = node  to-block 135  node finalized 135
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
  59       block 34       tx f604562c…a371610f  accept 6d69…0000/3 (3 record(s))
  90       block 118      tx 761ed938…5d531f75  accept 6d69…0000/3 (2 record(s))
  92       block 123      tx e54dd47a…69f06d6d  accept 6d69…0000/3 (6 record(s))
  94       block 130      tx 5153b762…43dd740e  accept 6d69…0000/3 (6 record(s))
  96       block 135      tx fe77b3fb…b8dd0288  accept 6d69…0000/3 (3 record(s))
```

The history is empty: the withdrawal at block 123 deleted every field, so the identity and its history are gone, and
nothing from before it comes back (MIP "Applying records"; vectors S3c, S3d). `list --to-block 118` (after the rename)
shows "Acme Bars"/"ABAR"; at blocks 123 and 130 (after each withdrawal) `list` reports
`identities  none: no token identity of this contract has a field with a value`.

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
  deploy                             completed  tx 6defaf26…d7060158 block 19 SUCCESS fee 1228706932471153 SPECK
  publish                            completed  tx 8ebacff8…36cda0d5 block 23 SUCCESS fee 146122510748296 SPECK
  verifier-key-remove:publishMetadata completed  tx 0f9333c9…1e32422a block 140 SUCCESS fee 38987436235576 SPECK
  publish-again                      pending    no tx
2026-10-07T19:55:56.680Z publish: publish-again: publishMetadata has no verifier key on 080aae689603534324e2c88181db52a3b36b9e2dc0fb8023edbb0f9ef10cefa6 (removed?); nothing submitted
```

The published payload is MIP Appendix A byte-for-byte (the example's domainSep is Appendix A's, `0x11` × 32); `list`
still shows it after the removal. The removal is a maintenance `VerifierKeyRemove` in the `v4` key slot (where ZKIR v3
keys live), signed with the maintenance key midnight-js generated at deployment and the CLI kept in the
private-state file.

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

One official proof server (9.0.1) proves the Compact 0.36.0 contract circuits and the wallet's DUST spends.

## Appendix: the same with plain midnight-js

[`scripts/midnight-js-snippet.ts`](scripts/midnight-js-snippet.ts) is what `mip0018 deploy-and-publish` does underneath,
without the record and the checks: `deployContract` with the owner secret as private state, then
`callTx.publishMetadata()` right after the deployment.

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

Run on the local chain (2026-10-07), then checked wallet-free with the expected payload from `metadata.json`:

```sh
MIP0018_DOCKER_NETWORK=$MIP0018_STACK_NETWORK MIP0018_DOCKER_ENV="-e MIP0018_INDEXER_URL=$MIP0018_INDEXER_URL_IN_NETWORK \
  -e MIP0018_NODE_URL=$MIP0018_NODE_URL_IN_NETWORK -e MIP0018_PROOF_SERVER_URL=$MIP0018_PROOF_SERVER_URL_IN_NETWORK" \
  docker/run.sh exec 'node examples/publish-and-emit/scripts/midnight-js-snippet.ts'
```

```text
{"contract":"3e612bb1926c897495728eee18572451a7f327cbda49f3b60f4602ba0c08610a","deploy":{"tx":"b8dc509dfbc00f0a69551f239f5abb58dad09d1dfd0e0cd11f44e5ea26cc9dd6","block":164},"publish":{"tx":"368f4b9716fb1db4280efbf3785e6c1d7d12ab72dd576e76bd8b828f4441da5c","block":167,"status":"SucceedEntirely"}}

$ mip0018 check-event --network undeployed --contract 3e612bb1…0c08610a --tx 368f4b97…f4441da5c --expect '{"payload":"6d69702d…","result":"accept"}'
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
