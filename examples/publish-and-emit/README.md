# examples/publish-and-emit — deploy a token and publish its MIP-0018 metadata with `mip0018`

This walkthrough takes a token that already has the MIP-0018 lines in its contract (the
[OpenZeppelin fungible token](../openzeppelin/fungible-token/README.md) and the
[minimal create-and-destroy contract](../minimal/README.md)), deploys it, publishes its metadata right after the
deployment, renames and withdraws it, and shows create-and-destroy — first on a local chain, then on Stagenet.
Every command below was run by the local end-to-end test (`packages/cli/test/e2e/examples-e2e.sh`, parts A and B;
it keeps its records under `/e2e/dap/` instead of `/walk/` and adds `--expect` and `--to-block` to some `list` calls);
the outputs are excerpts of that run (2026-10-03), with `/e2e/dap/` shown as `/walk/`.

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
  MIP0018_DOCKER_ENV="$NETENV -e MIP0018_PROOF_SERVER_URL=$MIP0018_PROOF_SERVER_URL_IN_NETWORK -e MIP0018_WALLET_PROOF_SERVER_URL=$MIP0018_WALLET_PROOF_SERVER_URL_IN_NETWORK" \
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
the deployment with the exact payload each must emit. The command deploys, calls `publishMetadata()` and verifies the
emission wallet-free (the indexer's event = the `log` op of the raw transaction, the node's block, finality, the
exact payload):

```text
network     undeployed  genesis 0x6356…56356a  indexer http://indexer:8088/api/v4/graphql
contract    d2976af7d59b3bb5f91472c9e5a5571a6a6d653b21a38a9848fe5699a1360b36
transaction d435f292c63513ac2d441b9a9ef1c71de38a0d66ddaac99fa4c45a13fd3f62a5  block 67 (25b2ec34…543b0f93)  SUCCESS  finalized (finalized head 67)  extrinsic 4
event 0     id 59  segment 56475 (guaranteed)  entry publishMetadata
  result    accept  domainSep 6d69702d303031383a6578616d706c653a66756e6769626c6500000000000000  kind 3 (ledger)
  records   name="Acme Gold" symbol="AGLD" decimals=6
  expected  matches
checks
  OK   identity             node genesis 0x635663c02847be53aacef6ba8e6153d6a6ff81e8f8be51dcc92d40fca056356a (undeployed)
  OK   indexed              transaction d435f292c63513ac2d441b9a9ef1c71de38a0d66ddaac99fa4c45a13fd3f62a5 in block 67 (25b2ec34a470cce6d9b64f8a33b489a3b305095636d216e918f1c004543b0f93), SUCCESS
  OK   raw-hash             recomputed hash d435f292c63513ac2d441b9a9ef1c71de38a0d66ddaac99fa4c45a13fd3f62a5
  OK   raw-identifiers      2 identifiers recomputed
  OK   event-0-record       event 59: bound to d2976af7d59b3bb5f91472c9e5a5571a6a6d653b21a38a9848fe5699a1360b36 (entry point publishMetadata), misc
  OK   event-0-in-raw-tx    event 59: equals a log op of the contract in the raw transaction
  OK   event-0-segment      event 59: its segment applied
  OK   completeness         1 applied Misc log(s) of the contract in the raw transaction, 1 indexed
  OK   node-block-hash      node block 67 = 0x25b2ec34a470cce6d9b64f8a33b489a3b305095636d216e918f1c004543b0f93
  OK   node-extrinsic       raw transaction bytes are extrinsic 4 of block 67
  OK   expect-0             event 59 matches the expectation
  OK   finalized            block 67 ≤ finalized 67
result      ok (exit 0)
record      /walk/fungible-token.json
network     undeployed  genesis 0x6356…56356a
contract    MyFungibleToken  d2976af7d59b3bb5f91472c9e5a5571a6a6d653b21a38a9848fe5699a1360b36
steps
  deploy                             completed  tx 0b321822…a603900c block 61 SUCCESS fee 4938164564525608 SPECK
  publish                            completed  tx d435f292…fd3f62a5 block 67 SUCCESS fee 164017660288561 SPECK
```

The fees are in SPECK (10^15 SPECK = 1 DUST): about 4.94 DUST for deploying the token with the verifier keys of all
its circuits, 0.16 DUST for the publish (local chain). On Stagenet the same token cost 6.967 DUST to deploy and
0.171 DUST to publish (case C01; all Stagenet fees in [`docs/costs.md`](../../docs/costs.md#fees-on-stagenet)).

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
    "address": "d2976af7d59b3bb5f91472c9e5a5571a6a6d653b21a38a9848fe5699a1360b36",
    "privateStateId": "MyFungibleToken",
    "constructorArgs": ["Acme Gold", "AGLD", 6],
    "verifierKeySha256": { "balanceOf": "1314444ccfea…", "burn": "fd37e5b4c1a4…", "decimals": "3cfdfb97570b…", "…": "…" }
  },
  "steps": [
    {
      "id": "deploy", "kind": "deploy", "state": "completed",
      "tx": { "hash": "0b32182233c41380724ac7aa5eada87e6da04c05f599430dee324de4a603900c", "ttl": "2026-10-03T05:21:00.000Z" },
      "inclusion": { "height": 61, "status": "SUCCESS", "fee": "4938164564525608" },
      "attempts": ["submitting 0b321822…", "node accepted 00323aab…", "midnight-js: SucceedEntirely at block 61", "completed: contract d2976af7… on chain with …"]
    },
    {
      "id": "publish", "kind": "call", "circuit": "publishMetadata", "state": "completed",
      "tx": { "hash": "d435f292c63513ac2d441b9a9ef1c71de38a0d66ddaac99fa4c45a13fd3f62a5" },
      "inclusion": { "height": 67, "status": "SUCCESS", "fee": "164017660288561" },
      "expectedEvents": [{ "name": "6d69702d303031383a746f6b656e2d6d657461646174615b76315d0000000000", "payload": "6d69702d…" }],
      "attempts": ["submitting d435f292…", "node accepted 00830e55…", "midnight-js: SucceedEntirely at block 67", "completed: 1 expected Misc event(s) observed in d435f292…"]
    }
  ]
}
```

The owner secret and the contract's maintenance key are not in it: they are in the 0600 private-state file.

## 5. Verify and list without a wallet

```sh
mip0018 verify --network undeployed --record /walk/fungible-token.json --step publish
mip0018 list --network undeployed --record /walk/fungible-token.json --expect @examples/openzeppelin/fungible-token/metadata.json
```

`verify` prints the same report as above (`result ok (exit 0)`). `list --json` (excerpt):

```text
"snapshot": { "indexerTip": { "height": 69, … }, "toBlock": 69, "tipMatchesNode": true, "finalizedHeight": 69 },
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

`withdrawMetadata` emits one event with a Null record at `name`, `symbol`, `decimals` and `standards` (`withdraw` in
the Compact module): every field is deleted, so consumers do not reference the token at all until a later record
describes it again (MIP "Applying records"). Each `publish` prints the record (the before/after checks in action — the
repeated withdrawal without `--force` is skipped, because it would change nothing):

```text
steps
  deploy                             completed  tx 0b321822…a603900c block 61 SUCCESS fee 4938164564525608 SPECK
  publish                            completed  tx d435f292…fd3f62a5 block 67 SUCCESS fee 164017660288561 SPECK
  rename                             completed  tx bca0d72c…dd0b7242 block 187 SUCCESS fee 170666944372062 SPECK
  withdraw                           completed  tx 338da73f…5b1d7cbc block 192 SUCCESS fee 170864752122948 SPECK
  withdraw-again-skipped             completed  no tx  (skipped: the contract metadata already holds exactly these values (before-check on the finalized transaction; nothing submitted))
```

(`withdraw-again-skipped` is the same command without `--force`; with `--force` the second withdrawal is emitted, as
the Stagenet cases C06 and C11 do on purpose.) After the revive, `list`:

```text
contract    d2976af7d59b3bb5f91472c9e5a5571a6a6d653b21a38a9848fe5699a1360b36  network undeployed
snapshot    indexer block 203 (dcf3940d…445193e5) = node  to-block 203  node finalized 203
events      5 (5 accepted, 0 rejected, 0 ignored) in 2 page(s)
identity  domainSep 6d69702d303031383a6578616d706c653a66756e6769626c6500000000000000  kind 3 (ledger)  color -
  name         "Acme Gold"                              type 1  usable
  symbol       "AGLD"                                   type 1  usable
  decimals     6                                        type 2  usable
  display      1 base unit = 0.000001 AGLD
groups
  "AGLD": 6d69…0000/3
history (replaced values; never current)
source events
  59       block 67       tx d435f292…fd3f62a5  accept 6d69…0000/3 (3 record(s))
  90       block 187      tx bca0d72c…dd0b7242  accept 6d69…0000/3 (2 record(s))
  92       block 192      tx 338da73f…5b1d7cbc  accept 6d69…0000/3 (4 record(s))
  94       block 198      tx 35385c0e…363d2bca  accept 6d69…0000/3 (4 record(s))
  96       block 203      tx c3613b4f…10a06fec  accept 6d69…0000/3 (3 record(s))
```

The history is empty: the withdrawal at block 192 deleted every field, so the identity and its history are gone, and
nothing from before it comes back (MIP "Applying records"; vectors S3c, S3d). `list --to-block 187` (after the rename)
shows "Acme Bars"/"ABAR"; at blocks 192 and 198 (after each withdrawal) `list` reports
`identities  none: no token identity of this contract has a field with a value`. The same lifecycle on Stagenet:
case [C11](../../deployments/stagenet/cases/C11/README.md).

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
  deploy                             completed  tx 8e79af52…3e034269 block 52 SUCCESS fee 1228716976298232 SPECK
  publish                            completed  tx ee36a358…e843786e block 56 SUCCESS fee 146132487220809 SPECK
  verifier-key-remove:publishMetadata completed  tx 9197c439…a2de45d3 block 208 SUCCESS fee 38997327095931 SPECK
  publish-again                      pending    no tx
2026-10-03T04:36:09.465Z publish: publish-again: publishMetadata has no verifier key on 1f39ef3aa3f0b9b756378e6f5081b614269412f1cadb1a7d248e1ca3c1739303 (removed?); nothing submitted
```

The published payload is MIP Appendix A byte-for-byte (the example's domainSep is Appendix A's, `0x11` × 32); `list`
still shows it after the removal. The removal is a maintenance `VerifierKeyRemove` in the `v4` key slot (where ZKIR v3
keys live), signed with the maintenance key midnight-js generated at deployment and the CLI kept in the
private-state file.

## 8. Stagenet

The same commands with `--network stagenet` and a wallet secret file instead of `--dev-genesis-wallet`. The secret
directory is mounted read-only into the signer container only; the wallet sync cache (`--wallet-cache`) avoids a
several-minute sync per command:

```sh
signer() {
  MIP0018_SECRET_DIR="<0700 directory with the mnemonic file>" MIP0018_STATE_DIR="<0700 state directory outside the repo>" \
  MIP0018_DOCKER_NETWORK="<network of your two proof servers>" \
  MIP0018_DOCKER_ENV="-e MIP0018_PROOF_SERVER_URL=<proof-server 9.0.0-rc.8> -e MIP0018_WALLET_PROOF_SERVER_URL=<proof-server 9.0.0-rc.6>" \
  docker/signer.sh mip0018 -- "$@"
}
W="--network stagenet --mnemonic-file /run/mip0018/secrets/<wallet>.mnemonic --wallet-cache /run/mip0018/state/wallet.cache"
signer deploy $W --example fungible-token --record deployments/stagenet/cases/C01/record.json
signer publish $W --record deployments/stagenet/cases/C01/record.json --circuit publishMetadata --step publish
```

Two official proof servers are needed: 9.0.0-rc.8 proves the Compact 0.35.0 / ZKIR v3 contract
circuits, 9.0.0-rc.6 the wallet's DUST spends. The recorded Stagenet runs — one `mip0018` command per step — are the
case folders [`deployments/stagenet/cases/`](../../deployments/stagenet/cases/README.md):

| Case | What | Contract | Publish transaction |
|---|---|---|---|
| [C01](../../deployments/stagenet/cases/C01/README.md) | OpenZeppelin fungible token: deploy, publish | `98a90519419e2ebb514b7c6ce87ee7f6f4f9753d9ee6f533c5d1c25b9d437dcf` | `a6fff9fb3f034aea393ff37fcd4343c418c3bfcc7cb22c502c1c1a6ffbc55dfd` (block 714501) |
| [C06](../../deployments/stagenet/cases/C06/README.md) | minimal OwnerKey (this deployment's `withdrawMetadata` emits one Null record at `name`): publish, rename, withdraw ×2, revive | `9d93b91942530f66f381daf5d9856caf9dfaa24444f0803a6c5d02e8c28040e3` | `71fb2c2d9ade1a3906ad92b3d245e6578478d58cac52d4f3f4c01fdbea2fc7e2` (block 714796; then rename 714804, withdraw 714813, withdraw again 714827, revive 714835) |
| [C11](../../deployments/stagenet/cases/C11/README.md) | minimal OwnerKey: publish, withdraw (four Null records) ×2, revive | `b05ee03f0e0f0edb6b3097d68c26a9c198365fe4900df493467d606738db6141` | `054ecbd532d6a4dc997269f147be7930726e7c434d5fc26f60e53df840563dd6` (block 724896; then withdraw 724916, withdraw again 724940, revive 724957) |
| [C10](../../deployments/stagenet/cases/C10/README.md) | minimal create-and-destroy | `048ec49aacdde9ef2fee1bd51c651df46d3224578e36a1e89bdbb88842edf0f6` | `85d6f8a241ceff9935dc1aec51e5c5c1c51818dd0a41ebf7b850e2ff413a5b4d` (block 715177; key removed in 715183) |

Run on 2026-10-02 (C11: 2026-10-03) with wallet 1 of this repository's test wallets; every case re-checks wallet-free with
`docker/run.sh mip0018 -- recheck --network stagenet --case deployments/stagenet/cases/<ID>`.

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

Run on the local chain (2026-10-03), then checked wallet-free with the expected payload from `metadata.json`:

```sh
MIP0018_DOCKER_NETWORK=$MIP0018_STACK_NETWORK MIP0018_DOCKER_ENV="-e MIP0018_INDEXER_URL=$MIP0018_INDEXER_URL_IN_NETWORK \
  -e MIP0018_NODE_URL=$MIP0018_NODE_URL_IN_NETWORK -e MIP0018_PROOF_SERVER_URL=$MIP0018_PROOF_SERVER_URL_IN_NETWORK \
  -e MIP0018_WALLET_PROOF_SERVER_URL=$MIP0018_WALLET_PROOF_SERVER_URL_IN_NETWORK" \
  docker/run.sh exec 'node examples/publish-and-emit/scripts/midnight-js-snippet.ts'
```

```text
{"contract":"797079fe19d1245f02337033fb353b2cfb7c764298f3cc5b6d91a8ecdeec4e44","deploy":{"tx":"c19f86a9b7b9c862854d13a502a928c93c9fefabe62b91225da2df8936a202fa","block":216},"publish":{"tx":"d7f27ccb37fb9318477851084fee6be0aba0257f65cb2b9db7d6f3038cfe4f80","block":219,"status":"SucceedEntirely"}}

$ mip0018 verify --network undeployed --contract 797079fe…deec4e44 --tx d7f27ccb…8cfe4f80 --expect '{"payload":"6d69702d…","result":"accept"}'
  result    accept  domainSep 6d69702d303031383a6578616d706c653a66756e6769626c6500000000000000  kind 3 (ledger)
  records   name="Acme Gold" symbol="AGLD" decimals=6
  expected  matches
result      ok (exit 0)
```

What the snippet does not do, and the CLI does: record the transaction before submission (a crash after submitting
leaves no trace here, and a blind re-run deploys a second contract), skip what the chain already shows, and confirm the
expected events through the indexer before calling a step done.
