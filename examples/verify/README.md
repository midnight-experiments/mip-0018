# examples/verify — check MIP-0018 metadata without a wallet

Everything here needs only Docker, this repository and the network's endpoints: no wallet and no secret. On `preview`
nothing else is needed; `preprod` and `mainnet` are served by Blockfrost, and each command reads the project token of
that network's Blockfrost project from `MIP0018_BLOCKFROST_PREPROD` / `MIP0018_BLOCKFROST_MAINNET` (or a 0600 file,
`--blockfrost-token-file`), passed to the container by name and written nowhere. `mip0018` runs in the pinned toolchain
image (`docker/run.sh mip0018 -- <command> …`); the same commands run on the local chain in the end-to-end tests
(`packages/cli/test/e2e/local-e2e.sh`, `examples-e2e.sh`).

```sh
mip0018() { docker/run.sh mip0018 -- "$@"; }     # preview: the public indexer and RPC are the defaults
```

Exit codes (every command): 0 ok · 1 mismatch · 2 usage · 3 not found · 4 not yet indexed / final (re-run).

## 1. One emission: `check-event`

```sh
mip0018 check-event --network preview --contract <contract address> --tx <transaction hash> --expect @<expectation file>
# or straight from a run record:
mip0018 check-event --network preview --record <run record> --step <step id> --expect @<expectation file>
```

What it checks, in order: the node's genesis is the network's pinned one (and its block 1 the chain instance, when one is known); the indexer's Misc event(s) of the contract in that
transaction; the event name; the contract address from the event record (never from the payload); the decoded payload
(accept / reject / ignore and the reason) with every record it carries — a key that is not a common key is marked "not
served", because consumers serve it only for a token that declares a standard defining it; the raw transaction (hash and identifiers recomputed, every indexed event
equals a `log` op of the contract in it, nothing missing); the node's block hash at that height, finality, and the raw
bytes inside the block's extrinsics; then the expectation, event by event.

Negative events are checked the same way — the expectation says what a conforming consumer must conclude (`reject` with
its reason and offset, `ignore` with its reason, or one result per event of a transaction with several). Every check
is OK and the exit code 0 when the conclusion is the expected one.

A rejected event is rejected whole and changes nothing; an ignored one (another name, e.g. `mip-0018:token-metadata[v2]`)
is not MIP-0018 v1 at all; two events in one transaction are independent (vector S7b); an accepted record whose key is
not served (vector S10a) is valid but does not appear in `list`.

## 2. Everything a contract published: `list`

```sh
mip0018 list --network preview --contract <contract address>
mip0018 list --network preview --record <run record> --expect @<expected state or metadata.json>
mip0018 list --network preview --record <run record> --to-block <height> --history
```

`list` pages every Misc event of the contract (until an empty page — a server that caps pages cannot truncate the
list), applies them in chain order with the reference consumer and prints each token identity that has at least one
served field — every served field (usable or not; a `name`/`symbol` over 64/12 characters as its first 64/12), the
color for kinds 1 and 2 — the symbol groups and the source events. An identity
whose fields were all deleted is not printed at all (MIP "Applying records"): a contract whose tokens were all withdrawn
prints `identities  none`. `--expect` compares the state with an expected one (a case's `expected.json`, or an example's
`metadata.json`); `--to-block` shows the state as of a block, and `--history` adds the replaced values, marked as
history (never current).

## 3. From a coin to its metadata: `index` and `lookup`

A wallet holding a shielded coin or an unshielded UTXO knows only its color (token type). The mint scanner reads every
block from a start height, decodes each successful contract call's mints and records
`color = tokenType(domainSep, contract) → (contract, domainSep, kinds minted, first mint)`; `lookup` resolves a color
through that table to the identity and its current metadata:

```sh
mip0018 index --network preview --from-height <height before the first mint> --to-height <height> --state <state directory>
mip0018 lookup --network preview --state <state directory> --color <color>
mip0018 lookup --network preview --state <state directory> --record <run record> --domain-sep <domainSep> --kind 1
```

The scanner records every mint on the chain in its range, so colors of other contracts appear in its table too. A color
that was never minted in the scanned range is reported as such (exit 3): a published identity is not proof that coins
of its color exist.

## 4. A whole case in one command: `recheck`

```sh
mip0018 recheck --network preview --case deployments/preview/cases/<ID>
```

`recheck` runs every check the case lists in its `case.json`: `check-event` of each recorded transaction with its
expectation, `list` against `expected.json` (and, for a case with several steps, the state after every step with `--to-block`),
steps that had to be refused (no transaction), removed verifier keys, and colors (the scanner's table, the wallet's
recorded balances, the live identity). When the case's network file (`deployments/<network>/network.json`)
records the chain instance of the run, every check also requires the node's block 1 to be that block: a network
re-created from the same genesis is refused instead of reported as missing data.

The issuer side — deploying and publishing — is [`examples/publish-and-emit`](../publish-and-emit/README.md); its
appendix shows the plain midnight-js calls (`deployContract`, `callTx`) the CLI wraps.
