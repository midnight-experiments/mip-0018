# examples/verify — check MIP-0018 metadata without a wallet

Everything here needs only Docker, this repository and public endpoints: no wallet, no secret, no account.
`mip0018` runs in the pinned toolchain image (`docker/run.sh mip0018 -- <command> …`). On Stagenet the commands work
against the recorded cases of [`deployments/stagenet/cases/`](../../deployments/stagenet/cases/README.md) (run on
2026-10-02, 2026-10-03 and 2026-10-07; contract addresses, transactions and blocks below are real; the outputs
were recorded on 2026-10-07). The outputs below are from Stagenet unless
marked "local"; the same commands also run on the local chain in the end-to-end test
(`packages/cli/test/e2e/examples-e2e.sh`).

```sh
mip0018() { docker/run.sh mip0018 -- "$@"; }     # Stagenet: the public indexer and RPC are the defaults
```

Exit codes (every command): 0 ok · 1 mismatch · 2 usage · 3 not found · 4 not yet indexed / final (re-run).

## 1. One emission: `check-event`

```sh
mip0018 check-event --network stagenet --contract 98a90519419e2ebb514b7c6ce87ee7f6f4f9753d9ee6f533c5d1c25b9d437dcf \
  --tx a6fff9fb3f034aea393ff37fcd4343c418c3bfcc7cb22c502c1c1a6ffbc55dfd \
  --expect @deployments/stagenet/cases/C01/expect/publish.json
# or straight from the case's run record:
mip0018 check-event --network stagenet --record deployments/stagenet/cases/C01/record.json --step publish \
  --expect @deployments/stagenet/cases/C01/expect/publish.json
```

What it checks, in order: the node's genesis is Stagenet's; the indexer's Misc event(s) of the contract in that
transaction; the event name; the contract address from the event record (never from the payload); the decoded payload
(accept / reject / ignore and the reason) with every record it carries — a key that is not a common key is marked "not
served", because consumers serve it only for a token that declares a standard defining it; the raw transaction (hash and identifiers recomputed, every indexed event
equals a `log` op of the contract in it, nothing missing); the node's block hash at that height, finality, and the raw
bytes inside the block's extrinsics; then the expectation, event by event.

Stagenet, case C01 (the OpenZeppelin fungible token's `publishMetadata()`):

```text
network     stagenet  genesis 0x2f76…3a9491  indexer https://indexer.stagenet.shielded.tools/api/v4/graphql
contract    98a90519419e2ebb514b7c6ce87ee7f6f4f9753d9ee6f533c5d1c25b9d437dcf
transaction a6fff9fb3f034aea393ff37fcd4343c418c3bfcc7cb22c502c1c1a6ffbc55dfd  block 714501 (787386cc…d386b3fd)  SUCCESS  finalized (finalized head 794231)  extrinsic 3
event 0     id 53431  segment 22981 (guaranteed)  entry publishMetadata
  result    accept  domainSep 6d69702d303031383a6578616d706c653a66756e6769626c6500000000000000  kind 3 (contract token)
  records   name         "Acme Gold"  type 1
            symbol       "AGLD"  type 1
            decimals     6  type 2
  expected  matches
checks
  OK   identity             node genesis 0x2f76825abc239fecf6107c9df99016de57037b451ae57a4394b76c8cf53a9491 (stagenet)
  OK   indexed              transaction a6fff9fb3f034aea393ff37fcd4343c418c3bfcc7cb22c502c1c1a6ffbc55dfd in block 714501 (787386ccc67dfc7c9285d6928d3a217ed91b88bcef86ce8420f6f8c7d386b3fd), SUCCESS
  OK   raw-hash             recomputed hash a6fff9fb3f034aea393ff37fcd4343c418c3bfcc7cb22c502c1c1a6ffbc55dfd
  OK   raw-identifiers      2 identifiers recomputed
  OK   event-0-record       event 53431: bound to 98a90519419e2ebb514b7c6ce87ee7f6f4f9753d9ee6f533c5d1c25b9d437dcf (entry point publishMetadata), misc
  OK   event-0-in-raw-tx    event 53431: equals a log op of the contract in the raw transaction
  OK   event-0-segment      event 53431: its segment applied
  OK   completeness         1 applied Misc log(s) of the contract in the raw transaction, 1 indexed
  OK   node-block-hash      node block 714501 = 0x787386ccc67dfc7c9285d6928d3a217ed91b88bcef86ce8420f6f8c7d386b3fd
  OK   node-extrinsic       raw transaction bytes are extrinsic 3 of block 714501
  OK   expect-0             event 53431 matches the expectation
  OK   finalized            block 714501 ≤ finalized 794231
result      ok (exit 0)
```

Negative events are checked the same way — the expectation says what a conforming consumer must conclude:

```sh
mip0018 check-event --network stagenet --record deployments/stagenet/cases/C07/record.json --step R1 \
  --expect @deployments/stagenet/cases/C07/expect/R1.json     # reject: no-records
mip0018 check-event --network stagenet --record deployments/stagenet/cases/C07/record.json --step I1a \
  --expect @deployments/stagenet/cases/C07/expect/I1a.json    # ignore: other-name ([v2])
mip0018 check-event --network stagenet --record deployments/stagenet/cases/C07/record.json --step A3c \
  --expect @deployments/stagenet/cases/C07/expect/A3c.json    # reject: a key that is not valid UTF-8 (vector R5i)
mip0018 check-event --network stagenet --record deployments/stagenet/cases/C08/record.json --step emit-two \
  --expect @deployments/stagenet/cases/C08/expect/emit-two.json   # two events: accept, then reject
mip0018 check-event --network stagenet --record deployments/stagenet/cases/C12/record.json --step s10a \
  --expect @deployments/stagenet/cases/C12/expect/s10a.json   # accept, key foo not served
```

Stagenet (cases C07, C08 and C12; the event lines of each report — every check is OK, exit 0, because the conclusion
is the expected one):

```text
$ # C07 R1
event 0     id 53500  segment 39552 (guaranteed)  entry emitRaw
  result    reject  reason no-records at offset 33
  expected  matches
$ # C07 I1a
event 0     id 53541  segment 49897 (guaranteed)  entry emitRaw
  result    ignore  reason other-name
  expected  matches
$ # C07 A3c
event 0     id 53516  segment 23795 (guaranteed)  entry emitRaw
  result    reject  reason invalid-utf8-key at offset 33
  expected  matches
$ # C08 emit-two
event 0     id 53553  segment 53948 (guaranteed)  entry emitTwo
  result    accept  domainSep 1111111111111111111111111111111111111111111111111111111111111111  kind 3 (contract token)
  records   name         "Good"  type 1
  expected  matches
event 1     id 53554  segment 53948 (guaranteed)  entry emitTwo
  result    reject  reason reserved-valtype at offset 44
  expected  matches
$ # C12 s10a
event 0     id 59812  segment 10541 (guaranteed)  entry emitRaw
  result    accept  domainSep 6d69702d303031383a73746167656e65743a4331320000000000000000000000  kind 3 (contract token)
  records   foo          "x"  type 1  not served (not a common key)
  expected  matches
```

A rejected event is rejected whole and changes nothing; an ignored one (another name, here `mip-0018:token-metadata[v2]`)
is not MIP-0018 v1 at all; two events in one transaction are independent (vector S7b); an accepted record whose key is
not served (C12 `s10a`, vector S10a) is valid but does not appear in `list`.

## 2. Everything a contract published: `list`

```sh
mip0018 list --network stagenet --contract 86acf80ff386abb610aadbea0406039e7fe39893f440794c3c2bad86dd48570f
mip0018 list --network stagenet --record deployments/stagenet/cases/C04/record.json --expect @deployments/stagenet/cases/C04/expected.json
mip0018 list --network stagenet --record deployments/stagenet/cases/C06/record.json --to-block 714804 --history
```

`list` pages every Misc event of the contract (until an empty page — a server that caps pages cannot truncate the
list), applies them in chain order with the reference consumer and prints each token identity that has at least one
served field — every served field (usable or not; a `name`/`symbol` over 64/12 characters as its first 64/12), the
color for kinds 1 and 2 — the symbol groups and the source events. An identity
whose fields were all deleted is not printed at all (MIP "Applying records"): a contract whose tokens were all withdrawn
prints `identities  none`. `--expect`
compares the state with an expected one (a case's `expected.json`, or an example's `metadata.json`).

Stagenet, case C04 (`list --contract 86acf80f…570f --expect @deployments/stagenet/cases/C04/expected.json`):

```text
contract    86acf80ff386abb610aadbea0406039e7fe39893f440794c3c2bad86dd48570f  network stagenet
snapshot    indexer block 794236 (a2403559…dff1e4ce) = node  to-block 794236  node finalized 794236
events      3 (3 accepted, 0 rejected, 0 ignored) in 2 page(s)
identity  domainSep 6d69702d303031383a6578616d706c653a6d756c74692d6b696e640000000000  kind 1 (shielded UTXO)  color 042399246139df031a4780c684df8eaecd48b7e03a195bfe986cf22766bcbc16
  name         "Acme Dollar"                            type 1  usable
  symbol       "ACD"                                    type 1  usable
  decimals     2                                        type 2  usable
  display      1 base unit = 0.01 ACD
identity  domainSep 6d69702d303031383a6578616d706c653a6d756c74692d6b696e640000000000  kind 2 (unshielded UTXO)  color 042399246139df031a4780c684df8eaecd48b7e03a195bfe986cf22766bcbc16
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
  53453    block 714663   tx 13315bf9…e1a95a06  accept 6d69…0000/1 (3 record(s))
  53454    block 714663   tx 13315bf9…e1a95a06  accept 6d69…0000/2 (3 record(s))
  53455    block 714663   tx 13315bf9…e1a95a06  accept 6d69…0000/3 (3 record(s))
expected    matches
```

Three identities from one transaction, one symbol group, and kinds 1 and 2 share one color (MIP Lookup) — wallet 1
holds that color both as a shielded coin and as an unshielded UTXO (`deployments/stagenet/cases/C04/wallet-status.json`).

The state at an earlier block, with replaced values as history (case C06 as of its rename, block 714804):

```text
contract    9d93b91942530f66f381daf5d9856caf9dfaa24444f0803a6c5d02e8c28040e3  network stagenet
snapshot    indexer block 794237 (7bc50c6d…c27e6caa) = node  to-block 714804  node finalized 794237
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
  stagenet|9…11111111|3 name: 1 earlier value(s)
  stagenet|9…11111111|3 symbol: 1 earlier value(s)
source events
  53471    block 714796   tx 71fb2c2d…ea2fc7e2  accept 1111…1111/3 (4 record(s))
  53477    block 714804   tx 2514eeca…5cc9c2e9  accept 1111…1111/3 (2 record(s))
```

A withdrawn token (case C11 as of its withdrawal, block 724916 — one event with a Null record for each of the token's four keys):

```text
contract    b05ee03f0e0f0edb6b3097d68c26a9c198365fe4900df493467d606738db6141  network stagenet
snapshot    indexer block 794238 (a406851d…ce7e4ff7) = node  to-block 724916  node finalized 794238
events      2 (2 accepted, 0 rejected, 0 ignored) in 2 page(s)
identities  none: no token identity of this contract has a field with a value
source events
  54200    block 724896   tx 054ecbd5…40563dd6  accept 1111…1111/3 (4 record(s))
  54204    block 724916   tx 5a869bf4…d1937150  accept 1111…1111/3 (4 record(s))
```

Case C12 (C07's contract, as of block 793977), excerpt: the served fields of C12's identity — `image`, the 31-byte
`image_sha256` (unusable), a 70-character name and a 15-character symbol shown as their first 64 / 12 characters
(grapheme clusters) — next to C07's identity; the record `foo = "x"` of step `s10a` is not served; the groups compare
the stored symbol bytes:

```text
contract    23aa27cbc948fb6df9072750b879e9b7f78206f77c638674a8e01b418ee3355b  network stagenet
snapshot    indexer block 794259 (f5f4e24c…defc7c82) = node  to-block 793977  node finalized 794259
events      26 (12 accepted, 10 rejected, 4 ignored) in 2 page(s)
identity  domainSep 1111111111111111111111111111111111111111111111111111111111111111  kind 3 (contract token)  color -
  symbol       "ACME"                                   type 1  usable
  decimals     6                                        type 2  usable
  name         "Acme"                                   type 1  usable
  display      1 base unit = 0.000001 ACME
identity  domainSep 6d69702d303031383a73746167656e65743a4331320000000000000000000000  kind 3 (contract token)  color -
  image        "https://example.org/acme.png"           type 4  usable
  image_sha256 0xdf0e7f2208098c42ba231bd6ed5eacce4c7a7b21e4eb5ea1a79bccb0fa2374 type 0  UNUSABLE
  name         "Acme Café token 🇺🇾 한각 Ångstrȫm, seventy characters for test S11a🇯🇵" type 1  usable  (first 64 characters of 70)
  symbol       "ÅCMé🇺🇾한XYZȫ12"                  type 1  usable  (first 12 characters of 15)
groups
  "ACME": 1111…1111/3
  "ÅCMé🇺🇾한XYZȫ123🇯🇵각": 6d69…0000/3
source events
  … (C07's 22 events, blocks 714891–715063)
  59810    block 793926   tx 0db0a504…e6043f54  accept 6d69…0000/3 (2 record(s))
  59812    block 793935   tx 7c23bed8…cbafb592  accept 6d69…0000/3 (1 record(s))
  59814    block 793967   tx 66ceb3f2…0c7b6abe  accept 6d69…0000/3 (2 record(s))
  59816    block 793977   tx e58241a4…78f77c26  accept 6d69…0000/3 (1 record(s))
```

## 3. From a coin to its metadata: `index` and `lookup`

A wallet holding a shielded coin or an unshielded UTXO knows only its color (token type). The mint scanner reads every
block from a start height, decodes each successful contract call's mints and records
`color = tokenType(domainSep, contract) → (contract, domainSep, kinds minted, first mint)`; `lookup` resolves a color
through that table to the identity and its current metadata:

```sh
mip0018 index --network stagenet --from-height 714485 --to-height 715183 \
  --state deployments/stagenet/cases/IDX/index
mip0018 lookup --network stagenet --state deployments/stagenet/cases/IDX/index \
  --color 8e01e39293a9e21ee2685da06ce487fffafbc1a982d53fcb1a72520f18518484
mip0018 lookup --network stagenet --state deployments/stagenet/cases/IDX/index \
  --record deployments/stagenet/cases/C05/record.json --domain-sep 0x6d69702d303031383a6578616d706c653a66616d696c793a62726f6e7a650000 --kind 1   # exit 3: never minted
```

Stagenet (case IDX: blocks 714485–715183 — the matrix's first inclusion height − 10 to its last — 699 blocks over the
`blocks` subscription in 6.4 s with 2 HTTP requests and 1 WebSocket, 58 contract calls, 7 mints, 6 colors, 0 decode
errors; one of the colors is another Stagenet user's mint, because the scanner records every mint on the chain):

```text
$ mip0018 lookup --network stagenet --state deployments/stagenet/cases/IDX/index --color 8e01e39293a9e21ee2685da06ce487fffafbc1a982d53fcb1a72520f18518484
color       8e01e39293a9e21ee2685da06ce487fffafbc1a982d53fcb1a72520f18518484
table       contract a3df52605d8b7210aa3e5cdc82de4bb2911975bc42c1a68be77044723b705f21  domainSep 6d69702d303031383a6578616d706c653a756e736869656c6465640000000000
minted      unshielded ×1 first at 714617
metadata    live indexer at block 794240
  identity  domainSep 6d69702d303031383a6578616d706c653a756e736869656c6465640000000000  kind 2 (unshielded UTXO)  color 8e01e39293a9e21ee2685da06ce487fffafbc1a982d53fcb1a72520f18518484
    name         "Acme Public"                            type 1  usable
    symbol       "APUB"                                   type 1  usable
    decimals     6                                        type 2  usable
    display      1 base unit = 0.000001 APUB

$ mip0018 lookup --network stagenet --state deployments/stagenet/cases/IDX/index --record deployments/stagenet/cases/C05/record.json \
    --domain-sep 0x6d69702d303031383a6578616d706c653a66616d696c793a62726f6e7a650000 --kind 1
color 4024a88428ad97c4315b4f2f8ed05adaafaad6876a7ec7223ca84765b5083e69 was not minted in the scanned range [714485, 715183] of stagenet
```

The UTXO color `8e01e392…8484` is the one wallet 1 holds (`deployments/stagenet/cases/C03/wallet-status.json` lists it
among its unshielded balances); bronze was published but never minted, so no coin of that color exists in the range
(exit 3).

## 4. A whole case in one command: `recheck`

```sh
mip0018 recheck --network stagenet --case deployments/stagenet/cases/C02
```

`recheck` runs every check the case lists in its `case.json`: `check-event` of each recorded transaction with its
expectation, `list` against `expected.json` (and, for C06, C11 and C12, the state after every step with `--to-block`;
C07 as of its last step),
steps that had to be refused (no transaction), removed verifier keys, and colors (the scanner's table, the wallet's
recorded balances, the live identity).

Stagenet:

```text
case C02  network stagenet  /work/deployments/stagenet/cases/C02
  OK   check-event publish                 tx 133501d0ee8b3139… block 714564: 1 event(s) accept, all 12 checks ok
  OK   list record.json                    1 identity, 1 event(s) (1 accepted, 0 rejected, 0 ignored) = expected.json at block 794242
  OK   color "mip-0018:example:shielded"/1 tokenType = be34ef4b78717b031040bf625e04ee033106efae4c766915d3cac2b7fda8f11b; wallet holds 1000000 of it (shielded); live identity ASHD as expected
result ok (3/3)

case IDX  network stagenet  /work/deployments/stagenet/cases/IDX
  OK   color "mip-0018:example:shielded"/1      tokenType = be34ef4b78717b031040bf625e04ee033106efae4c766915d3cac2b7fda8f11b; scanner: minted ×1 first at 714557; live identity ASHD as expected
  OK   color "mip-0018:example:unshielded"/2    tokenType = 8e01e39293a9e21ee2685da06ce487fffafbc1a982d53fcb1a72520f18518484; scanner: minted ×1 first at 714617; live identity APUB as expected
  OK   color "mip-0018:example:multi-kind"/1    tokenType = 042399246139df031a4780c684df8eaecd48b7e03a195bfe986cf22766bcbc16; scanner: minted ×1 first at 714643; live identity ACD as expected
  OK   color "mip-0018:example:multi-kind"/2    tokenType = 042399246139df031a4780c684df8eaecd48b7e03a195bfe986cf22766bcbc16; scanner: minted ×1 first at 714649; live identity ACD as expected
  OK   color "mip-0018:example:family:gold"/1   tokenType = 81db4eef83089c5403c6af29d926d57ee6b6359ff7dc291dd19cb4c3e9cf7aa1; scanner: minted ×1 first at 714683; live identity MEDAL as expected
  OK   color "mip-0018:example:family:silver"/1 tokenType = 8c74ec4a937d296f8234a2373812c2df3d962dba06dfe98cda390f9dea38491d; scanner: minted ×1 first at 714689; live identity MEDAL as expected
  OK   color "mip-0018:example:family:bronze"/1 tokenType = 4024a88428ad97c4315b4f2f8ed05adaafaad6876a7ec7223ca84765b5083e69; not minted in the scanned range [714485, 715183], as expected; live identity MEDAL as expected
result ok (7/7)
```

Every Stagenet case re-checks from a clean checkout in a wallet-free container (see
[`deployments/stagenet/README.md`](../../deployments/stagenet/README.md)); the 14 cases hold 89 checks: C01 2, C02 3,
C03 3, C04 4, C05 6, C06 11, C07 23, C08 2, C09 2, C10 4, C11 9 (the full withdrawal), C12 9 (image, served keys,
lengths), IDX 7, U1 4 (the existing-contract upgrade).

## Stagenet cases

| Case | What | Re-check |
|---|---|---|
| [C01](../../deployments/stagenet/cases/C01/README.md)–[C12](../../deployments/stagenet/cases/C12/README.md), [IDX](../../deployments/stagenet/cases/IDX/README.md), [U1](../../deployments/stagenet/cases/U1/README.md) | see the [case index](../../deployments/stagenet/cases/README.md) | `mip0018 recheck --network stagenet --case deployments/stagenet/cases/<ID>` |

Addresses, transactions, blocks and fees: the case table in [`deployments/stagenet/README.md`](../../deployments/stagenet/README.md)
and each case's README (rendered from its `record.json`).

The issuer side — deploying and publishing — is [`examples/publish-and-emit`](../publish-and-emit/README.md); its
appendix shows the plain midnight-js calls (`deployContract`, `callTx`) the CLI wraps.
