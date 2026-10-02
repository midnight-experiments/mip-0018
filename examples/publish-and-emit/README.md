# examples/publish-and-emit — deploy a token and publish its MIP-0018 metadata with `mip0018`

This walkthrough takes a token that already has the MIP-0018 lines in its contract (the
[OpenZeppelin fungible token](../openzeppelin/fungible-token/README.md) and the
[minimal create-and-destroy contract](../minimal/README.md)), deploys it, publishes its metadata right after the
deployment, renames and withdraws it, and shows create-and-destroy — first on a local chain, then on Stagenet.
Every command below was run by the local end-to-end test (`packages/cli/test/e2e/examples-e2e.sh`, parts A and B;
it keeps its records under `/e2e/dap/` instead of `/walk/` and adds `--expect` to some `list` calls); the outputs are
excerpts of that run (2026-10-02).

What `mip0018` adds to the plain midnight-js calls (shown in the [appendix](#appendix-the-same-with-plain-midnight-js)):
a public **run record** per contract (address, every transaction, written *before* submission), a **before-check**
that skips a step the chain already shows done (no duplicate deploy or publish on a re-run), and an **after-check**
that marks a step completed only when the indexer shows the expected change (questions Q13, Q27).

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
contract    2b251a237e852e21251e023b8d5bebc8a4b90b4564668f946f4cc2f02ba1fcff
transaction ab80a07a48b21f673bd166f56f10587ddb9fc421cb73a55d80fefac51d29ce30  block 30 (612445b9…3a1fcf0e)  SUCCESS  finalized (finalized head 30)  extrinsic 4
event 0     id 59  segment 19467 (guaranteed)  entry publishMetadata
  result    accept  domainSep 6d69702d303031383a6578616d706c653a66756e6769626c6500000000000000  kind 3 (ledger)
  records   name="Acme Gold" symbol="AGLD" decimals=6
  expected  matches
checks
  OK   identity             node genesis 0x635663c02847be53aacef6ba8e6153d6a6ff81e8f8be51dcc92d40fca056356a (undeployed)
  OK   indexed              transaction ab80a07a…1d29ce30 in block 30 (612445b9…3a1fcf0e), SUCCESS
  OK   raw-hash             recomputed hash ab80a07a48b21f673bd166f56f10587ddb9fc421cb73a55d80fefac51d29ce30
  OK   raw-identifiers      2 identifiers recomputed
  OK   event-0-record       event 59: bound to 2b251a23…2ba1fcff (entry point publishMetadata), misc
  OK   event-0-in-raw-tx    event 59: equals a log op of the contract in the raw transaction
  OK   event-0-segment      event 59: its segment applied
  OK   completeness         1 applied Misc log(s) of the contract in the raw transaction, 1 indexed
  OK   node-block-hash      node block 30 = 0x612445b979bc8a7977f30fd7a700f1a928489dc34c62e8c9519526313a1fcf0e
  OK   node-extrinsic       raw transaction bytes are extrinsic 4 of block 30
  OK   expect-0             event 59 matches the expectation
  OK   finalized            block 30 ≤ finalized 30
result      ok (exit 0)
record      /walk/fungible-token.json
network     undeployed  genesis 0x6356…56356a
contract    MyFungibleToken  2b251a237e852e21251e023b8d5bebc8a4b90b4564668f946f4cc2f02ba1fcff
steps
  deploy                             completed  tx 8e6aae96…186ad1b5 block 27 SUCCESS fee 4938164564525608 SPECK
  publish                            completed  tx ab80a07a…1d29ce30 block 30 SUCCESS fee 164017660288561 SPECK
```

The fees are in SPECK (10^15 SPECK = 1 DUST): about 4.94 DUST for deploying the token with the verifier keys of all
its circuits, 0.16 DUST for the publish (local chain; Stagenet costs are in [`docs/costs.md`](../../docs/costs.md)
once S5 has run).

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
    "address": "2b251a237e852e21251e023b8d5bebc8a4b90b4564668f946f4cc2f02ba1fcff",
    "privateStateId": "MyFungibleToken",
    "constructorArgs": ["Acme Gold", "AGLD", 6],
    "verifierKeySha256": { "balanceOf": "1314444ccfea…", "burn": "fd37e5b4c1a4…", "decimals": "3cfdfb97570b…", "…": "…" }
  },
  "steps": [
    {
      "id": "deploy", "kind": "deploy", "state": "completed",
      "tx": { "hash": "8e6aae9639f9210968605f8b2637c5aae281419497ba08ddee123e51186ad1b5", "ttl": "2026-10-02T05:35:54.000Z" },
      "inclusion": { "height": 27, "status": "SUCCESS", "fee": "4938164564525608" },
      "attempts": ["submitting 8e6aae96…", "node accepted 00901e4e…", "midnight-js: SucceedEntirely at block 27", "completed: contract 2b251a23… on chain with …"]
    },
    {
      "id": "publish", "kind": "call", "circuit": "publishMetadata", "state": "completed",
      "tx": { "hash": "ab80a07a48b21f673bd166f56f10587ddb9fc421cb73a55d80fefac51d29ce30" },
      "inclusion": { "height": 30, "status": "SUCCESS", "fee": "164017660288561" },
      "expectedEvents": [{ "name": "6d69702d303031383a746f6b656e2d6d657461646174615b76315d0000000000", "payload": "6d69702d…" }],
      "attempts": ["submitting ab80a07a…", "node accepted 00e4bf9a…", "midnight-js: SucceedEntirely at block 30", "completed: 1 expected Misc event(s) observed in ab80a07a…"]
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
"snapshot": { "indexerTip": { "height": 30, … }, "toBlock": 30, "tipMatchesNode": true, "finalizedHeight": 30 },
"counts": { "events": 1, "accepted": 1, "rejected": 0, "ignored": 0 },
"identities": [ { "domainSep": "6d69702d303031383a6578616d706c653a66756e6769626c6500000000000000", "kind": 3,
                  "visible": true, "colored": false, "common": { "name": "Acme Gold", "symbol": "AGLD", "decimals": "6" }, … } ],
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

Each `publish` prints the record (the before/after checks in action — the repeated tombstone without `--force` is
skipped, because it would change nothing):

```text
steps
  deploy                             completed  tx 8e6aae96…186ad1b5 block 27 SUCCESS fee 4938164564525608 SPECK
  publish                            completed  tx ab80a07a…1d29ce30 block 30 SUCCESS fee 164017660288561 SPECK
  rename                             completed  tx 440886f2…c1b39b7a block 115 SUCCESS fee 170656936443867 SPECK
  withdraw                           completed  tx 95ba4b9a…391090d8 block 120 SUCCESS fee 170474818389749 SPECK
  withdraw-again-skipped             completed  no tx  (skipped: the contract metadata already holds exactly these values (before-check on the finalized transaction; nothing submitted))
```

(`withdraw-again-skipped` is the same command without `--force`; with `--force` the second tombstone is emitted, as the
Stagenet case C06 does on purpose.) After the revive, `list`:

```text
contract    2b251a237e852e21251e023b8d5bebc8a4b90b4564668f946f4cc2f02ba1fcff  network undeployed
snapshot    indexer block 131 (b96b3e69…7effe8d0) = node  to-block 131  node finalized 131
events      5 (5 accepted, 0 rejected, 0 ignored) in 2 page(s)
identity  domainSep 6d69702d303031383a6578616d706c653a66756e6769626c6500000000000000  kind 3 (ledger)  visible  color -
  name         "Acme Gold"                              type 1  usable
  symbol       "AGLD"                                   type 1  usable
  decimals     6                                        type 2  usable
  display      1 base unit = 0.000001 AGLD
groups
  "AGLD": 6d69…0000/3
history (replaced values; never current)
source events
  59       block 30       tx ab80a07a…1d29ce30  accept 6d69…0000/3 (3 record(s))
  90       block 115      tx 440886f2…c1b39b7a  accept 6d69…0000/3 (2 record(s))
  92       block 120      tx 95ba4b9a…391090d8  accept 6d69…0000/3 (1 record(s))
  94       block 126      tx e17c51f1…b7b2d69f  accept 6d69…0000/3 (1 record(s))
  96       block 131      tx c6594977…218efe0b  accept 6d69…0000/3 (3 record(s))
```

The history is empty: the tombstone at block 120 cleared every field, and nothing from before a tombstone ever comes
back (MIP "Updates"; vector S3c). Between the rename and the withdraw, `list --to-block 119` shows "Acme Bars"/"ABAR".

## 7. Create and destroy

The minimal [`CreateAndDestroy`](../minimal/contracts/CreateAndDestroy.compact) contract has an unguarded
`publishMetadata()` with a constant payload (MIP Appendix A with the domainSep given at deployment). The deployer
publishes once, then removes the circuit's verifier key with a maintenance `VerifierKeyRemove` (question Q4); after
that nobody can call it:

```sh
signer deploy-and-publish $A --example minimal --record /walk/minimal.json
signer remove-circuit $A --record /walk/minimal.json --circuit publishMetadata
signer publish $A --record /walk/minimal.json --circuit publishMetadata --step publish-again --force   # exit 1
```

```text
steps
  deploy                             completed  tx ac70d9c7…c1ef48a0 block 18 SUCCESS fee 1228716976298232 SPECK
  publish                            completed  tx 76d2c42f…89fed2f6 block 22 SUCCESS fee 146132487220809 SPECK
  verifier-key-remove:publishMetadata completed  tx 5d0d35ed…a9fb7681 block 136 SUCCESS fee 38997198295448 SPECK
  publish-again                      pending    no tx
mip0018: publish: publishMetadata has no verifier key on 0a6a41be…1561 (removed?); nothing submitted
```

The published payload is MIP Appendix A byte-for-byte (the example's domainSep is Appendix A's, `0x11` × 32); `list`
still shows it after the removal. The removal is a maintenance `VerifierKeyRemove` in the `v4` key slot (ZKIR v3
circuits; question Q23), signed with the maintenance key midnight-js generated at deployment and the CLI kept in the
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

Two official proof servers are needed today (question Q21): 9.0.0-rc.8 proves the Compact 0.35.0 / ZKIR v3 contract
circuits, 9.0.0-rc.6 the wallet's DUST spends. The recorded Stagenet runs — one `mip0018` command per step — are the
case folders [`deployments/stagenet/cases/`](../../deployments/stagenet/cases/README.md):

| Case | What | Contract | Publish transaction |
|---|---|---|---|
| [C01](../../deployments/stagenet/cases/C01/README.md) | OpenZeppelin fungible token: deploy, publish | _S5_ | _S5_ |
| [C06](../../deployments/stagenet/cases/C06/README.md) | minimal OwnerKey: publish, rename, tombstone ×2, revive | _S5_ | _S5_ |
| [C10](../../deployments/stagenet/cases/C10/README.md) | minimal create-and-destroy | _S5_ | _S5_ |

(_S5_: filled in when the Stagenet matrix runs.)

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

Run on the local chain (2026-10-02), then checked wallet-free with the expected payload from `metadata.json`:

```sh
MIP0018_DOCKER_NETWORK=$MIP0018_STACK_NETWORK MIP0018_DOCKER_ENV="-e MIP0018_INDEXER_URL=$MIP0018_INDEXER_URL_IN_NETWORK \
  -e MIP0018_NODE_URL=$MIP0018_NODE_URL_IN_NETWORK -e MIP0018_PROOF_SERVER_URL=$MIP0018_PROOF_SERVER_URL_IN_NETWORK \
  -e MIP0018_WALLET_PROOF_SERVER_URL=$MIP0018_WALLET_PROOF_SERVER_URL_IN_NETWORK" \
  docker/run.sh exec 'node examples/publish-and-emit/scripts/midnight-js-snippet.ts'
```

```text
{"contract":"d9d2345aae2775d6f75910c042e260399ef0dd42c38dd78053d65309bed4037b","deploy":{"tx":"7c2847b88deaf1e3605521210913097311a22ec33a9aa1a698105414e7a58ac2","block":483},"publish":{"tx":"a00cccfe0e4504a269a508b99b471dcc6abe92c02b22551f187824f6ec354310","block":487,"status":"SucceedEntirely"}}

$ mip0018 verify --network undeployed --contract d9d2345a…bed4037b --tx a00cccfe…ec354310 --expect '{"payload":"6d69702d…","result":"accept"}'
  result    accept  domainSep 6d69702d303031383a6578616d706c653a66756e6769626c6500000000000000  kind 3 (ledger)
  records   name="Acme Gold" symbol="AGLD" decimals=6
  expected  matches
result      ok (exit 0)
```

What the snippet does not do, and the CLI does: record the transaction before submission (a crash after submitting
leaves no trace here, and a blind re-run deploys a second contract), skip what the chain already shows, and confirm the
expected events through the indexer before calling a step done.
