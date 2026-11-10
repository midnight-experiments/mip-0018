# examples/verify — check MIP-0018 metadata without a wallet

Everything here needs only Docker, this repository and the network's endpoints: no wallet and no secret. On `preview`
nothing else is needed; `preprod` and `mainnet` are served by Blockfrost, and each command reads the project token of
that network's Blockfrost project from `MIP0018_BLOCKFROST_PREPROD` / `MIP0018_BLOCKFROST_MAINNET` (or a 0600 file,
`--blockfrost-token-file`), passed to the container by name and written nowhere. `mip0018` runs in the pinned toolchain
image (`docker/run.sh mip0018 -- <command> …`). On preview the commands work against the recorded cases of
[`deployments/preview/cases/`](../../deployments/preview/cases/README.md) (run on 2026-11-09; contract addresses,
transactions and blocks below are real; the outputs were recorded on 2026-11-09, between the preview blocks 42,463 and
42,470). The same commands also run on the local chain in the end-to-end tests
(`packages/cli/test/e2e/local-e2e.sh`, `examples-e2e.sh`).

```sh
mip0018() { docker/run.sh mip0018 -- "$@"; }     # preview: the public indexer and RPC are the defaults
```

Exit codes (every command): 0 ok · 1 mismatch · 2 usage · 3 not found · 4 not yet indexed / final (re-run).

## 1. One emission: `check-event`

```sh
mip0018 check-event --network preview --contract c135766fdc8ef3ae24fcd1e89bd37f66513a9f5948e7d034567de24aaae9237e \
  --tx 57f8a00479674d1498b1c2dfa6a3b44f82f6ee822aa8c3c41df6ce1907fb77e7 \
  --expect @deployments/preview/cases/C01/expect/publish.json
# or straight from the case's run record:
mip0018 check-event --network preview --record deployments/preview/cases/C01/record.json --step publish \
  --expect @deployments/preview/cases/C01/expect/publish.json
```

What it checks, in order: the node's genesis is the network's pinned one (and its block 1 the chain instance, when one
is known); the indexer's Misc event(s) of the contract in that transaction; the event name; the contract address from
the event record (never from the payload); the decoded payload (accept / reject / ignore and the reason) with every
record it carries — a key that is not a common key is marked "not served", because consumers serve it only for a token
that declares a standard defining it; the raw transaction (hash and identifiers recomputed, every indexed event equals
a `log` op of the contract in it, nothing missing); the node's block hash at that height, finality, and the raw bytes
inside the block's extrinsics; then the expectation, event by event.

Preview, case C01 (the OpenZeppelin fungible token's `publishMetadata()`; both commands print the same report):

```text
network     preview  genesis 0x3c09…d13796  indexer https://indexer.preview.midnight.network/api/v4/graphql
contract    c135766fdc8ef3ae24fcd1e89bd37f66513a9f5948e7d034567de24aaae9237e
transaction 57f8a00479674d1498b1c2dfa6a3b44f82f6ee822aa8c3c41df6ce1907fb77e7  block 41547 (83045afd…2bde2335)  SUCCESS  finalized (finalized head 42463)  extrinsic 3
event 0     id 13238  segment 42250 (guaranteed)  entry publishMetadata
  result    accept  domainSep 6d69702d303031383a6578616d706c653a66756e6769626c6500000000000000  kind 3 (contract token)
  records   name         "Acme Gold"  type 1
            symbol       "AGLD"  type 1
            decimals     6  type 2
  expected  matches
checks
  OK   identity             node genesis 0x3c096de209e06a1a8c52be7bda109ee8c891a42288c0a9db5495f9616dd13796 (preview)
  OK   indexed              transaction 57f8a00479674d1498b1c2dfa6a3b44f82f6ee822aa8c3c41df6ce1907fb77e7 in block 41547 (83045afdaca03cda82a9ae8b769726b28217ecbc004e6e01e6320f392bde2335), SUCCESS
  OK   raw-hash             recomputed hash 57f8a00479674d1498b1c2dfa6a3b44f82f6ee822aa8c3c41df6ce1907fb77e7
  OK   raw-identifiers      2 identifiers recomputed
  OK   event-0-record       event 13238: bound to c135766fdc8ef3ae24fcd1e89bd37f66513a9f5948e7d034567de24aaae9237e (entry point publishMetadata), misc
  OK   event-0-in-raw-tx    event 13238: equals a log op of the contract in the raw transaction
  OK   event-0-segment      event 13238: its segment applied
  OK   completeness         1 applied Misc log(s) of the contract in the raw transaction, 1 indexed
  OK   node-block-hash      node block 41547 = 0x83045afdaca03cda82a9ae8b769726b28217ecbc004e6e01e6320f392bde2335
  OK   node-extrinsic       raw transaction bytes are extrinsic 3 of block 41547
  OK   expect-0             event 13238 matches the expectation
  OK   finalized            block 41547 ≤ finalized 42463
result      ok (exit 0)
```

Negative events are checked the same way — the expectation says what a conforming consumer must conclude:

```sh
mip0018 check-event --network preview --record deployments/preview/cases/C07/record.json --step R1 \
  --expect @deployments/preview/cases/C07/expect/R1.json     # reject: no-records
mip0018 check-event --network preview --record deployments/preview/cases/C07/record.json --step I1a \
  --expect @deployments/preview/cases/C07/expect/I1a.json    # ignore: other-name ([v2])
mip0018 check-event --network preview --record deployments/preview/cases/C07/record.json --step A3c \
  --expect @deployments/preview/cases/C07/expect/A3c.json    # reject: a key that is not valid UTF-8 (vector R5i)
mip0018 check-event --network preview --record deployments/preview/cases/C08/record.json --step emit-two \
  --expect @deployments/preview/cases/C08/expect/emit-two.json   # two events: accept, then reject
mip0018 check-event --network preview --record deployments/preview/cases/C12/record.json --step s10a \
  --expect @deployments/preview/cases/C12/expect/s10a.json   # accept, key foo not served
```

Preview (cases C07, C08 and C12; the event lines of each report — every check is OK, exit 0, because the conclusion
is the expected one):

```text
$ # C07 R1
event 0     id 13303  segment 10165 (guaranteed)  entry emitRaw
  result    reject  reason no-records at offset 33
  expected  matches
$ # C07 I1a
event 0     id 13341  segment 54922 (guaranteed)  entry emitRaw
  result    ignore  reason other-name
  expected  matches
$ # C07 A3c
event 0     id 13317  segment 51965 (guaranteed)  entry emitRaw
  result    reject  reason invalid-utf8-key at offset 33
  expected  matches
$ # C08 emit-two
event 0     id 13353  segment 35192 (guaranteed)  entry emitTwo
  result    accept  domainSep 1111111111111111111111111111111111111111111111111111111111111111  kind 3 (contract token)
  records   name         "Good"  type 1
  expected  matches
event 1     id 13354  segment 35192 (guaranteed)  entry emitTwo
  result    reject  reason reserved-valtype at offset 44
  expected  matches
$ # C12 s10a
event 0     id 13367  segment 57761 (guaranteed)  entry emitRaw
  result    accept  domainSep 6d69702d303031383a707265766965773a433132000000000000000000000000  kind 3 (contract token)
  records   foo          "x"  type 1  not served (not a common key)
  expected  matches
```

A rejected event is rejected whole and changes nothing; an ignored one (another name, here
`mip-0018:token-metadata[v2]`) is not MIP-0018 v1 at all; two events in one transaction are independent (vector S7b);
an accepted record whose key is not served (C12 `s10a`, vector S10a) is valid but does not appear in `list`.

## 2. Everything a contract published: `list`

```sh
mip0018 list --network preview --contract 63d973a7df1b383cca57d8fab9c2a2ee3fa08bc92baada5dc3f12863ad1bfe93 \
  --expect @deployments/preview/cases/C04/expected.json
mip0018 list --network preview --record deployments/preview/cases/C06/record.json --to-block 41736 --history
mip0018 list --network preview --record deployments/preview/cases/C06/record.json --to-block 41744
```

`list` pages every Misc event of the contract (until an empty page — a server that caps pages cannot truncate the
list), applies them in chain order with the reference consumer and prints each token identity that has at least one
served field — every served field (usable or not; a `name`/`symbol` over 64/12 characters as its first 64/12), the
color for kinds 1 and 2 — the symbol groups and the source events. An identity whose fields were all deleted is not
printed at all (MIP "Applying records"): a contract whose tokens were all withdrawn prints `identities  none`.
`--expect` compares the state with an expected one (a case's `expected.json`, or an example's `metadata.json`);
`--to-block` shows the state as of a block, and `--history` adds the replaced values, marked as history (never
current).

Preview, case C04:

```text
contract    63d973a7df1b383cca57d8fab9c2a2ee3fa08bc92baada5dc3f12863ad1bfe93  network preview
snapshot    indexer block 42466 (4bdf64be…2fc74807) = node  to-block 42466  node finalized 42467
events      3 (3 accepted, 0 rejected, 0 ignored) in 2 page(s)
identity  domainSep 6d69702d303031383a6578616d706c653a6d756c74692d6b696e640000000000  kind 1 (shielded UTXO)  color 056c310ebcb469c9c5b8974842104ada748a84c2c42824be0f1ed165e3d81b2a
  name         "Acme Dollar"                            type 1  usable
  symbol       "ACD"                                    type 1  usable
  decimals     2                                        type 2  usable
  display      1 base unit = 0.01 ACD
identity  domainSep 6d69702d303031383a6578616d706c653a6d756c74692d6b696e640000000000  kind 2 (unshielded UTXO)  color 056c310ebcb469c9c5b8974842104ada748a84c2c42824be0f1ed165e3d81b2a
  name         "Acme Dollar"                            type 1  usable
  symbol       "ACD"                                    type 1  usable
  decimals     2                                        type 2  usable
  display      1 base unit = 0.01 ACD
identity  domainSep 6d69702d303031383a6578616d706c653a6d756c74692d6b696e640000000000  kind 3 (contract token)  color -
  name         "Acme Dollar"                            type 1  usable
  symbol       "ACD"                                    type 1  usable
  decimals     2                                        type 2  usable
  display      1 base unit = 0.01 ACD
groups
  "ACD": 6d69…0000/1, 6d69…0000/2, 6d69…0000/3
source events
  13263    block 41655    tx 3cded881…0391aae8  accept 6d69…0000/1 (3 record(s))
  13264    block 41655    tx 3cded881…0391aae8  accept 6d69…0000/2 (3 record(s))
  13265    block 41655    tx 3cded881…0391aae8  accept 6d69…0000/3 (3 record(s))
expected    matches
```

Three identities from one transaction, one symbol group, and kinds 1 and 2 share one color (MIP Lookup) — wallet 1
holds that color both as a shielded coin and as an unshielded UTXO (`deployments/preview/cases/C04/wallet-status.json`).

The state at an earlier block, with replaced values as history (case C06 as of its rename, block 41736):

```text
contract    f53dbefbedcf5a5ab992b343e6b4f66585883a929b6a0d277290066268f7ff4a  network preview
snapshot    indexer block 42467 (f17eed5e…044d48ae) = node  to-block 41736  node finalized 42467
events      2 (2 accepted, 0 rejected, 0 ignored) in 2 page(s)
identity  domainSep 1111111111111111111111111111111111111111111111111111111111111111  kind 3 (contract token)  color -
  name         "Acme Prime"                             type 1  usable
  symbol       "ACMP"                                   type 1  usable
  decimals     6                                        type 2  usable
  standards    "mip-0004"                               type 1  usable
  display      1 base unit = 0.000001 ACMP
groups
  "ACMP": 1111…1111/3
history (replaced values; never current)
  preview|f5…11111111|3 name: 1 earlier value(s)
  preview|f5…11111111|3 symbol: 1 earlier value(s)
source events
  13285    block 41728    tx a7c889e8…dff20b6c  accept 1111…1111/3 (4 record(s))
  13287    block 41736    tx 7c499199…207a7afd  accept 1111…1111/3 (2 record(s))
```

A withdrawn token (case C06 as of its withdrawal, block 41744 — one event with a Null record at each of the six common
keys):

```text
contract    f53dbefbedcf5a5ab992b343e6b4f66585883a929b6a0d277290066268f7ff4a  network preview
snapshot    indexer block 42467 (f17eed5e…044d48ae) = node  to-block 41744  node finalized 42467
events      3 (3 accepted, 0 rejected, 0 ignored) in 2 page(s)
identities  none: no token identity of this contract has a field with a value
source events
  13285    block 41728    tx a7c889e8…dff20b6c  accept 1111…1111/3 (4 record(s))
  13287    block 41736    tx 7c499199…207a7afd  accept 1111…1111/3 (2 record(s))
  13289    block 41744    tx 890fca4e…3eabc298  accept 1111…1111/3 (6 record(s))
```

Case C12 (C07's contract, as of block 42095:
`mip0018 list --network preview --record deployments/preview/cases/C12/record.json --to-block 42095`), excerpt: the
served fields of C12's identity — `image`, the 31-byte `image_sha256` (unusable), a 70-character name and a
15-character symbol shown as their first 64 / 12 characters (grapheme clusters) — next to C07's identity; the record
`foo = "x"` of step `s10a` is not served; the kind-1 identity of vector S3a's events keeps `symbol`, `decimals` and
`standards` after the Null record at `name`; the groups compare the stored symbol bytes:

```text
contract    cd2fd7655fd4481daa50ea0e7ed7095247dd7f15c48d746116a2fa6e02fdb6a9  network preview
snapshot    indexer block 42468 (249821ba…1b24deef) = node  to-block 42095  node finalized 42468
events      28 (14 accepted, 10 rejected, 4 ignored) in 2 page(s)
identity  domainSep 1111111111111111111111111111111111111111111111111111111111111111  kind 3 (contract token)  color -
  symbol       "ACME"                                   type 1  usable
  decimals     6                                        type 2  usable
  name         "Acme"                                   type 1  usable
  display      1 base unit = 0.000001 ACME
identity  domainSep 6d69702d303031383a707265766965773a433132000000000000000000000000  kind 3 (contract token)  color -
  image        "https://example.org/acme.png"           type 4  usable
  image_sha256 0xdf0e7f2208098c42ba231bd6ed5eacce4c7a7b21e4eb5ea1a79bccb0fa2374 type 0  UNUSABLE
  name         "Acme Café token 🇺🇾 한각 Ångstrȫm, seventy characters for test S11a🇯🇵" type 1  usable  (first 64 characters of 70)
  symbol       "ÅCMé🇺🇾한XYZȫ12"                  type 1  usable  (first 12 characters of 15)
identity  domainSep 1111111111111111111111111111111111111111111111111111111111111111  kind 1 (shielded UTXO)  color 285e90d649119e4434ff268734f2c76ff86fe391e8efe9b5977d5a518d0afa6d
  symbol       "GLD"                                    type 1  usable
  decimals     6                                        type 2  usable
  standards    "mip-0011"                               type 1  usable
  display      1 base unit = 0.000001 GLD
groups
  "ACME": 1111…1111/3
  "ÅCMé🇺🇾한XYZȫ123🇯🇵각": 6d69…0000/3
  "GLD": 1111…1111/1
source events
  … (C07's 22 events, blocks 41785–41952)
  13363    block 42054    tx 8efc7949…1815b802  accept 6d69…0000/3 (2 record(s))
  13367    block 42063    tx fff38dbe…6b1260ae  accept 6d69…0000/3 (1 record(s))
  13371    block 42071    tx b3b8e6ec…37f0d9e3  accept 6d69…0000/3 (2 record(s))
  13373    block 42079    tx 4239fb9d…20531439  accept 6d69…0000/3 (1 record(s))
  13375    block 42087    tx 66977c42…6f0250f5  accept 1111…1111/1 (4 record(s))
  13377    block 42095    tx 9912b1a7…f808f6f5  accept 1111…1111/1 (1 record(s))
```

## 3. From a coin to its metadata: `index` and `lookup`

A wallet holding a shielded coin or an unshielded UTXO knows only its color (token type). The mint scanner reads every
block from a start height, decodes each successful contract call's mints and records
`color = tokenType(domainSep, contract) → (contract, domainSep, kinds minted, first mint)`; `lookup` resolves a color
through that table to the identity and its current metadata:

```sh
mip0018 index --network preview --from-height 41531 --to-height 42095 \
  --state deployments/preview/cases/IDX/index
mip0018 lookup --network preview --state deployments/preview/cases/IDX/index \
  --color 651ab6b0dd7ccb521586f3c14e235842171cbf27ba43ad5d3ac52aa991ce77d0
mip0018 lookup --network preview --state deployments/preview/cases/IDX/index \
  --record deployments/preview/cases/C05/record.json --domain-sep 0x6d69702d303031383a6578616d706c653a66616d696c793a62726f6e7a650000 --kind 1   # exit 3: never minted
```

Preview (case IDX: blocks 41531–42095 — the matrix's first inclusion height − 10 to its last — 565 blocks over the
`blocks` subscription in 3.3 s with 2 HTTP requests and 1 WebSocket, 75 transactions, 50 contract calls, 9 deploys,
6 mints, 41 MIP-0018 events, 0 decode errors, 5 colors (`deployments/preview/cases/IDX/index-summary.json`); the scanner records every mint on the chain, and in this range all of
them are the cases'):

```text
$ mip0018 lookup --network preview --state deployments/preview/cases/IDX/index --color 651ab6b0dd7ccb521586f3c14e235842171cbf27ba43ad5d3ac52aa991ce77d0
color       651ab6b0dd7ccb521586f3c14e235842171cbf27ba43ad5d3ac52aa991ce77d0
table       contract f6e2fac7659ec945494ceaed8c17c5f6cc88af9e6d7f83c9f88f6c9f33b42a1c  domainSep 6d69702d303031383a6578616d706c653a756e736869656c6465640000000000
minted      unshielded ×1 first at 41605
metadata    live indexer at block 42469
  identity  domainSep 6d69702d303031383a6578616d706c653a756e736869656c6465640000000000  kind 2 (unshielded UTXO)  color 651ab6b0dd7ccb521586f3c14e235842171cbf27ba43ad5d3ac52aa991ce77d0
    name         "Acme Public"                            type 1  usable
    symbol       "APUB"                                   type 1  usable
    decimals     6                                        type 2  usable
    display      1 base unit = 0.000001 APUB

$ mip0018 lookup --network preview --state deployments/preview/cases/IDX/index --record deployments/preview/cases/C05/record.json \
    --domain-sep 0x6d69702d303031383a6578616d706c653a66616d696c793a62726f6e7a650000 --kind 1
color f3a250ea5d41f3ffcaf1064e04bd8a79aded9adf8d1bf38332ea5de98a4cc608 was not minted in the scanned range [41531, 42095] of preview
```

The UTXO color `651ab6b0…77d0` is the one wallet 1 holds (`deployments/preview/cases/C03/wallet-status.json` lists it
among its unshielded balances); bronze was published but never minted, so no coin of that color exists in the range
(exit 3). The scanner records every mint on the chain in its range, so a scan of another range can list colors of
other contracts too: a published identity is not proof that coins of its color exist.

## 4. A whole case in one command: `recheck`

```sh
mip0018 recheck --network preview --case deployments/preview/cases/C02
```

`recheck` runs every check the case lists in its `case.json`: `check-event` of each recorded transaction with its
expectation, `list` against `expected.json` (and, for C06 and C12, the state after every step with `--to-block`; C07
as of its last step), steps that had to be refused (no transaction), removed verifier keys, and colors (the scanner's
table, the wallet's recorded balances, the live identity). Every check also requires the node's genesis and its block
1 to be those `deployments/preview/network.json` records: a network re-created from the same genesis is refused
instead of reported as missing data.

Preview:

```text
case C02  network preview  /work/deployments/preview/cases/C02
  OK   check-event publish                 tx 56caf0bbf78a09d9… block 41576: 1 event(s) accept, all 12 checks ok
  OK   list record.json                    1 identity, 1 event(s) (1 accepted, 0 rejected, 0 ignored) = expected.json at block 42470
  OK   color "mip-0018:example:shielded"/1 tokenType = 6899f7c71eaac1384f0ed6575c62777897f5bba7e25f7f0d151b2a72241a26d8; wallet holds 1000000 of it (shielded); live identity ASHD as expected
result ok (3/3)

case IDX  network preview  /work/deployments/preview/cases/IDX
  OK   color "mip-0018:example:shielded"/1      tokenType = 6899f7c71eaac1384f0ed6575c62777897f5bba7e25f7f0d151b2a72241a26d8; scanner: minted ×1 first at 41569; live identity ASHD as expected
  OK   color "mip-0018:example:unshielded"/2    tokenType = 651ab6b0dd7ccb521586f3c14e235842171cbf27ba43ad5d3ac52aa991ce77d0; scanner: minted ×1 first at 41605; live identity APUB as expected
  OK   color "mip-0018:example:multi-kind"/1    tokenType = 056c310ebcb469c9c5b8974842104ada748a84c2c42824be0f1ed165e3d81b2a; scanner: minted ×1 first at 41635; live identity ACD as expected
  OK   color "mip-0018:example:multi-kind"/2    tokenType = 056c310ebcb469c9c5b8974842104ada748a84c2c42824be0f1ed165e3d81b2a; scanner: minted ×1 first at 41641; live identity ACD as expected
  OK   color "mip-0018:example:family:gold"/1   tokenType = 58325446d1e1b0cd816504bfce22e387ed13975abed88fac313f1947f24c0487; scanner: minted ×1 first at 41678; live identity MEDAL as expected
  OK   color "mip-0018:example:family:silver"/1 tokenType = 7c98ff4715c5f47f2a1502a9e4d727a163608a31bb7fa459355a46e135e9da5a; scanner: minted ×1 first at 41684; live identity MEDAL as expected
  OK   color "mip-0018:example:family:bronze"/1 tokenType = f3a250ea5d41f3ffcaf1064e04bd8a79aded9adf8d1bf38332ea5de98a4cc608; not minted in the scanned range [41531, 42095], as expected; live identity MEDAL as expected
result ok (7/7)
```

Every preview case re-checks from a clean checkout in a wallet-free container (see
[`deployments/preview/README.md`](../../deployments/preview/README.md)); the 13 cases hold 84 checks: C01 2, C02 3,
C03 3, C04 4, C05 6, C06 11 (the lifecycle and the full withdrawal), C07 23, C08 2, C09 2, C10 4, C12 13 (image, served
keys, lengths, the single-key delete), IDX 7, U1 4 (the existing-contract upgrade).

## Preview cases

| Case | What | Re-check |
|---|---|---|
| [C01](../../deployments/preview/cases/C01/README.md)–[C10](../../deployments/preview/cases/C10/README.md), [C12](../../deployments/preview/cases/C12/README.md), [IDX](../../deployments/preview/cases/IDX/README.md), [U1](../../deployments/preview/cases/U1/README.md) | see the [case index](../../deployments/preview/cases/README.md) | `mip0018 recheck --network preview --case deployments/preview/cases/<ID>` |

Addresses, transactions, blocks and fees: the case table in [`deployments/preview/README.md`](../../deployments/preview/README.md)
and each case's README (rendered from its `record.json`).

The issuer side — deploying and publishing — is [`examples/publish-and-emit`](../publish-and-emit/README.md); its
appendix shows the plain midnight-js calls (`deployContract`, `callTx`) the CLI wraps.
