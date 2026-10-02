# examples/verify — check MIP-0018 metadata without a wallet

Everything here needs only Docker, this repository and public endpoints: no wallet, no secret, no account.
`mip0018` runs in the pinned toolchain image (`docker/run.sh mip0018 -- <command> …`). On Stagenet the commands work
against the recorded cases of [`deployments/stagenet/cases/`](../../deployments/stagenet/cases/README.md); the
`<S5: …>` values are filled in when S5 runs the matrix. The same commands were run on the local chain by the local
end-to-end test (`packages/cli/test/e2e/examples-e2e.sh`); the local outputs below are excerpts of that run.

```sh
mip0018() { docker/run.sh mip0018 -- "$@"; }     # Stagenet: the public indexer and RPC are the defaults
```

Exit codes (every command): 0 ok · 1 mismatch · 2 usage · 3 not found · 4 not yet indexed / final (re-run).

## 1. One emission: `verify`

```sh
mip0018 verify --network stagenet --contract <S5: C01 contract> --tx <S5: C01 publish tx> \
  --expect @deployments/stagenet/cases/C01/expect/publish.json
# or straight from the case's run record:
mip0018 verify --network stagenet --record deployments/stagenet/cases/C01/record.json --step publish \
  --expect @deployments/stagenet/cases/C01/expect/publish.json
```

What it checks, in order: the node's genesis is Stagenet's; the indexer's Misc event(s) of the contract in that
transaction; the event name; the contract address from the event record (never from the payload); the decoded payload
(accept / reject / ignore and the reason); the raw transaction (hash and identifiers recomputed, every indexed event
equals a `log` op of the contract in it, nothing missing); the node's block hash at that height, finality, and the raw
bytes inside the block's extrinsics; then the expectation, event by event.

Local run of case C01 (`verify --network undeployed --record /e2e/cases/C01/record.json --step publish --expect …`):

```text
network     undeployed  genesis 0x6356…56356a  indexer http://indexer:8088/api/v4/graphql
contract    d1acb41045dd96e993cae414b9acb15d40b768812edb508b9c070de846750cf5
transaction 245d9158a372cea542f6ae94e22a9ab946909be71a7c8ca2e6e969b937ad872c  block 147 (0680a5b9…042242f6)  SUCCESS  finalized (finalized head 147)  extrinsic 4
event 0     id 100  segment 23617 (guaranteed)  entry publishMetadata
  result    accept  domainSep 6d69702d303031383a6578616d706c653a66756e6769626c6500000000000000  kind 3 (ledger)
  records   name="Acme Gold" symbol="AGLD" decimals=6
  expected  matches
checks
  OK   identity             node genesis 0x635663c02847be53aacef6ba8e6153d6a6ff81e8f8be51dcc92d40fca056356a (undeployed)
  OK   indexed              transaction 245d9158…37ad872c in block 147 (0680a5b9…042242f6), SUCCESS
  OK   raw-hash             recomputed hash 245d9158a372cea542f6ae94e22a9ab946909be71a7c8ca2e6e969b937ad872c
  OK   raw-identifiers      2 identifiers recomputed
  OK   event-0-record       event 100: bound to d1acb410…46750cf5 (entry point publishMetadata), misc
  OK   event-0-in-raw-tx    event 100: equals a log op of the contract in the raw transaction
  OK   event-0-segment      event 100: its segment applied
  OK   completeness         1 applied Misc log(s) of the contract in the raw transaction, 1 indexed
  OK   node-block-hash      node block 147 = 0x0680a5b989066f2e31c747e0f6d7369b989101944d625b4b263a9b22042242f6
  OK   node-extrinsic       raw transaction bytes are extrinsic 4 of block 147
  OK   expect-0             event 100 matches the expectation
  OK   finalized            block 147 ≤ finalized 147
result      ok (exit 0)
```

Stagenet: _S5_ (C01's contract and publish transaction).

Negative events are verified the same way — the expectation says what a conforming consumer must conclude:

```sh
mip0018 verify --network stagenet --record deployments/stagenet/cases/C07/record.json --step R1 \
  --expect @deployments/stagenet/cases/C07/expect/R1.json     # reject: no-records
mip0018 verify --network stagenet --record deployments/stagenet/cases/C07/record.json --step I1a \
  --expect @deployments/stagenet/cases/C07/expect/I1a.json    # ignore: other-name ([v2])
mip0018 verify --network stagenet --record deployments/stagenet/cases/C08/record.json --step emit-two \
  --expect @deployments/stagenet/cases/C08/expect/emit-two.json   # two events: accept, then reject
```

Local run (cases C07 and C08; the event lines of each report, condensed — every check is OK, exit 0, because the
conclusion is the expected one):

```text
C07 R1    event 0  id 145  entry emitRaw   result reject  reason no-records at offset 33        expected matches
C07 I1a   event 0  id 179  entry emitRaw   result ignore  reason other-name                     expected matches
C08       event 0  id 188  entry emitTwo   result accept  domainSep 1111…1111 kind 3  records name="Good"   expected matches
          event 1  id 189  entry emitTwo   result reject  reason reserved-valtype at offset 44  expected matches
```

A rejected event is rejected whole and changes nothing; an ignored one (another name, here `mip-0018:token-metadata[v2]`)
is not MIP-0018 v1 at all; two events in one transaction are independent (vector S7b).

## 2. Everything a contract published: `list`

```sh
mip0018 list --network stagenet --contract <S5: C04 contract>
mip0018 list --network stagenet --record deployments/stagenet/cases/C04/record.json --expect @deployments/stagenet/cases/C04/expected.json
mip0018 list --network stagenet --record deployments/stagenet/cases/C06/record.json --to-block <S5: C06 rename block> --history
```

`list` pages every Misc event of the contract (until an empty page — a server that caps pages cannot truncate the
list), applies them in chain order with the reference consumer and prints each token identity: visible or withdrawn,
every field (usable or not), the color for kinds 1 and 2, the symbol groups and the source events. `--expect`
compares the state with an expected one (a case's `expected.json`, or an example's `metadata.json`).

Local run of case C04 (`list --record /e2e/cases/C04/record.json --expect @deployments/stagenet/cases/C04/expected.json`):

```text
contract    68b3a34ac0dae9b4d1fd3c26d887e57be1a2251d7364a6976e611bfe20acd2d9  network undeployed
snapshot    indexer block 498 (fe243ad4…4baffb09) = node  to-block 498  node finalized 498
events      3 (3 accepted, 0 rejected, 0 ignored) in 2 page(s)
identity  domainSep 6d69702d303031383a6578616d706c653a6d756c74692d6b696e640000000000  kind 1 (native shielded)  visible  color fdf4fc981659a0aa500091ece2f8719e5e70753788af616f821942cb07c1ff6c
  name         "Acme Dollar"                            type 1  usable
  symbol       "ACD"                                    type 1  usable
  decimals     2                                        type 2  usable
  display      1 base unit = 0.01 ACD
identity  domainSep 6d69702d303031383a6578616d706c653a6d756c74692d6b696e640000000000  kind 2 (native unshielded)  visible  color fdf4fc981659a0aa500091ece2f8719e5e70753788af616f821942cb07c1ff6c
  (same fields)
identity  domainSep 6d69702d303031383a6578616d706c653a6d756c74692d6b696e640000000000  kind 3 (ledger)  visible  color -
  (same fields)
groups
  "ACD": 6d69…0000/1, 6d69…0000/2, 6d69…0000/3
source events
  116      block 207      tx 26692efd…b1281ded  accept 6d69…0000/1 (3 record(s))
  117      block 207      tx 26692efd…b1281ded  accept 6d69…0000/2 (3 record(s))
  118      block 207      tx 26692efd…b1281ded  accept 6d69…0000/3 (3 record(s))
expected    matches
```

Three identities from one transaction, one symbol group, and kinds 1 and 2 share one color (MIP note N3).

## 3. From a coin to its metadata: `index` and `lookup`

A wallet holding a shielded coin or an unshielded UTXO knows only its color (token type). The mint scanner reads every
block from a start height, decodes each successful contract call's mints and records
`color = tokenType(domainSep, contract) → (contract, domainSep, kinds minted, first mint)`; `lookup` resolves a color
through that table to the identity and its current metadata:

```sh
mip0018 index --network stagenet --from-height <S5: first matrix block − 10> --to-height <S5: last matrix block> \
  --state deployments/stagenet/cases/IDX/index
mip0018 lookup --network stagenet --state deployments/stagenet/cases/IDX/index --color <S5: C03 UTXO color>
mip0018 lookup --network stagenet --state deployments/stagenet/cases/IDX/index \
  --record deployments/stagenet/cases/C05/record.json --domain-sep <bronze domainSep> --kind 1   # exit 3: never minted
```

Local run (case IDX: blocks 132–444, 313 blocks over the `blocks` subscription in 12.8 s, 43 contract calls, 6 mints,
5 colors, 0 decode errors):

```text
$ mip0018 lookup --network undeployed --state /e2e/cases/IDX/index --color f30896a6c40ac6b5460e835ec7ff05851a5a5684fc3d4bc7978d40b29582896b
color       f30896a6c40ac6b5460e835ec7ff05851a5a5684fc3d4bc7978d40b29582896b
table       contract 1d66df4180b2847d69e1d1731ccc49f9554e0e2279a80f677acbfaf4b8a9738f  domainSep 6d69702d303031383a6578616d706c653a756e736869656c6465640000000000
minted      unshielded ×1 first at 174
metadata    live indexer at block 498
  identity  domainSep 6d69702d303031383a6578616d706c653a756e736869656c6465640000000000  kind 2 (native unshielded)  visible  color f30896a6c40ac6b5460e835ec7ff05851a5a5684fc3d4bc7978d40b29582896b
    name         "Acme Public"                            type 1  usable
    symbol       "APUB"                                   type 1  usable
    decimals     6                                        type 2  usable
    display      1 base unit = 0.000001 APUB

$ mip0018 lookup --network undeployed --state /e2e/cases/IDX/index --record /e2e/cases/C05/record.json \
    --domain-sep 0x6d69702d303031383a6578616d706c653a66616d696c793a62726f6e7a650000 --kind 1
color f2670d9245b175fac91c3428f50e7a9249833bd97634b66da779b0eea48bd726 was not minted in the scanned range [132, 444] of undeployed
```

The UTXO color `f30896a6…` is the one the wallet holds (`wallet status --json` of case C03 lists it among its
unshielded balances); bronze was published but never minted, so no coin of that color exists in the range (exit 3).

## 4. A whole case in one command: `recheck`

```sh
mip0018 recheck --network stagenet --case deployments/stagenet/cases/C02
```

`recheck` runs every check the case lists in its `case.json`: `verify` of each recorded transaction with its
expectation, `list` against `expected.json` (and, for C06, the state after every lifecycle step with `--to-block`),
steps that had to be refused (no transaction), removed verifier keys, and colors (the scanner's table, the wallet's
recorded balances, the live identity).

Local runs:

```text
case C02  network undeployed  /work/deployments/stagenet/cases/C02
  OK   verify publish                      tx a68dacff092a830c… block 163: 1 event(s) accept, all 12 checks ok
  OK   list record.json                    1 identity, 1 event(s) (1 accepted, 0 rejected, 0 ignored) = expected.json at block 498
  OK   color "mip-0018:example:shielded"/1 tokenType = fcb36435ab7c1a6646c0a77788b8bb3615239452419ce85d4db0f6e959364e7a; wallet holds 1000000 of it (shielded); live identity ASHD visible=true
result ok (3/3)

case IDX  network undeployed  /work/deployments/stagenet/cases/IDX
  OK   color "mip-0018:example:shielded"/1      tokenType = fcb36435…; scanner: minted ×1 first at 157; live identity ASHD visible=true
  OK   color "mip-0018:example:unshielded"/2    tokenType = f30896a6…; scanner: minted ×1 first at 174; live identity APUB visible=true
  OK   color "mip-0018:example:multi-kind"/1    tokenType = fdf4fc98…; scanner: minted ×1 first at 190; live identity ACD visible=true
  OK   color "mip-0018:example:multi-kind"/2    tokenType = fdf4fc98…; scanner: minted ×1 first at 195; live identity ACD visible=true
  OK   color "mip-0018:example:family:gold"/1   tokenType = 62000542…; scanner: minted ×1 first at 218; live identity MEDAL visible=true
  OK   color "mip-0018:example:family:silver"/1 tokenType = 73a621a2…; scanner: minted ×1 first at 223; live identity MEDAL visible=true
  OK   color "mip-0018:example:family:bronze"/1 tokenType = f2670d92…; not minted in the scanned range [132, 444], as expected; live identity MEDAL visible=true
result ok (7/7)
```

Every case of the local run re-checked: C01 2/2, C02 3/3, C03 3/3, C04 4/4, C05 6/6, C06 11/11, C07 23/23, C08 2/2,
C09 2/2, C10 4/4, IDX 7/7.

## Stagenet cases

| Case | What | Re-check |
|---|---|---|
| [C01](../../deployments/stagenet/cases/C01/README.md)–[C10](../../deployments/stagenet/cases/C10/README.md), [IDX](../../deployments/stagenet/cases/IDX/README.md) | see the [case index](../../deployments/stagenet/cases/README.md) | `mip0018 recheck --network stagenet --case deployments/stagenet/cases/<ID>` |

Addresses, transactions and blocks: _S5_ (filled in when the matrix runs).

The issuer side — deploying and publishing — is [`examples/publish-and-emit`](../publish-and-emit/README.md); its
appendix shows the plain midnight-js calls (`deployContract`, `callTx`) the CLI wraps.
