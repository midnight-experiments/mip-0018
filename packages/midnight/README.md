# `@mip0018/midnight`

Chain access for the MIP-0018 scripts on Midnight 2.x (ledger v9; indexer 4.4.101, the schema preview, preprod and
mainnet serve).
Two entry points:

| Entry | For | Never touches |
|---|---|---|
| `@mip0018/midnight` | anyone: check an event emission, list a contract's metadata, scan mints, look up colors | wallets, secrets |
| `@mip0018/midnight/signer` | the issuer (signer container only): wallet session, deploy / call / verifier-key removal with run records and before/after checks | — |

## Wallet-free (`src/`)

| Module | What it does |
|---|---|
| `network.ts` | Profiles `preview`, `preprod`, `mainnet` (network id, genesis, endpoints and address prefixes pinned, = `toolchain.json`; `preprod` / `mainnet`: the Blockfrost project token from `MIP0018_BLOCKFROST_PREPROD` / `MIP0018_BLOCKFROST_MAINNET` or a 0600 file, kept outside the profile and added as `project_id` only by `connectUrl` / `httpFor` / `indexerFor` / `rpcFor`) and `undeployed` (every URL required, never a default; public hosts and genesis hashes refused). `checkIdentity` = `chain_getBlockHash(0)` against the profile, and block 1 against its chain instance when one is known; `bindRecordedNetworks` binds a profile to the genesis and chain instance a run record, a scanner state or a network file recorded (another network, or a conflicting genesis / chain instance, is a `ProfileError`); `checkChainIdentity` also returns block 1 |
| `network-file.ts` | `identitySources(paths)`, the one collection of the identity sources of the files a command acts on: each file's own recorded network (a run record, a scanner state, a network file) and the network file of the case folder it lies in (`deployments/<network>/network.json` for `deployments/<network>/cases/<ID>/…`); `profileForFiles` binds a profile to them, `agreeFiles` checks that they agree |
| `tool.ts` | `runTool` (a script body under `guardOutput`; an error becomes one scrubbed line and exit 1), used by the CLI and the scripts |
| `redact.ts` | `redactUrl` (no query string, fragment or credentials) for every URL written; `redactUrls` for library messages (also empties a `project_id` value in any notation); `removeSecrets` for a registered token anywhere in output; `registerSecret`, which also installs `guardOutput` (every write to stdout / stderr through `removeSecrets`); `ScrubbedError`, the base of every error that can carry server or transport text (scrubbed when built, cause kept only as scrubbed text); `publicCopy`, the copy a public file is written from: published values (a file's `exact` paths) keep every byte but a registered token, messages and endpoint URLs go through `scrubSecrets`, every other string and key loses the credentials of a URL's authority, `project_id` values and registered tokens |
| `public-file.ts` | `writePublicJson`, the one writer of the public JSON files (run records, scanner states, network files, the local tools' records): `publicCopy` of the value, atomically (temporary file, optional fsync, rename); the value itself is not changed |
| `http.ts` | JSON over HTTP: timeout, bounded retries (408/425/429/5xx, `Retry-After`; a 429 pauses every request of the client), minimum interval between requests (public endpoints: 250 ms); 401/403 with a token → `TokenError` naming its variable |
| `rpc.ts` | Node RPC: block hash, finalized head, header, block extrinsics (raw-transaction presence), versions |
| `indexer.ts` | GraphQL v4 — the only module that knows the `@beta` contract-event surfaces: tip, transaction by hash, a contract's Misc events paged until an **empty** page (no silent truncation), the check-event bundle (events + transaction + tip in one request), contract state, block / `blocks` subscription for the scanner |
| `ws.ts` | Minimal `graphql-transport-ws` client (Node's global WebSocket) |
| `raw.ts` | ledger-v9 decoding of a raw transaction: hash, identifiers, deploys, maintenance updates, every `log` op (Misc data zero-extended to 288 bytes) and mint effect in ledger order; which parts were applied (guaranteed unless FAILURE; fallible only in a successful segment); event envelopes (`midnight:event[v14]`) |
| `color.ts` | `tokenType(domainSep, contractAddress)` with ledger-v9 `rawTokenType` (+ an independent SHA-256 derivation used in tests) |
| `check-event.ts` | One event emission (`mip0018 check-event`): indexer event, name, binding from the event record, classification (accept / reject / ignore + reason), raw-transaction cross-check, node block hash, finality, extrinsic presence, optional expectation. Outcomes ok / mismatch / not-found / not-indexed |
| `list.ts` | All MIP-0018 events of a contract reduced with `@mip0018/consumer` (colors injected for kinds 1 and 2) |
| `scanner.ts` | The mint scanner (MIP "Lookup"): from a start height, every block → contract calls' raw transactions → applied `shieldedMints` / `unshieldedMints` → `color → (contract, domainSep, kinds, first mint)`, plus every MIP-0018 event and every deploy; atomic checkpoint after each block; resumable; the state records the chain instance (block 1) and every read on its behalf (a resume, a live `lookup`) is bound to it first (`bindScanState`; a state without one is read only where the node has its last scanned block at that height, and a resume then records the node's block 1 in the file at once); `lookupColor` |

## Signer (`src/signer/`)

| Module | What it does |
|---|---|
| `secrets.ts` | Secrets only from file paths (regular file, mode ≤ 0600, no symlink); BIP-39 mnemonic → seed; hex seeds for local test wallets |
| `wallet.ts` | Wallet SDK 2.0.0 (seeds from `WalletSeeds.fromMasterSeed`) behind midnight-js 5.0.0 providers, transactions crossing as bytes; one proof server for the wallet's proofs; complete sync (3 consecutive strictly-complete samples); DUST registration without double signing; `feeBlocksMargin` 5 |
| `providers.ts` | midnight-js providers for a compiled contract; the contract-circuit proof server wrapped with ≤ 4 concurrent proofs and retries on 408/429/502/504 |
| `private-state.ts` | 0600 file for maintenance keys and witness private state, per-contract views (`forContract`) (typed JSON for bytes and bigints) |
| `maintenance.ts` | `VerifierKeyRemove` / `VerifierKeyInsert` in the `v4` slot for ZKIR-v3 circuits, signed with a given maintenance key at its committee index, submitted with midnight-js `submitTx` |
| `args.ts` | `--args` JSON → runtime values: circuit arguments with the compiler's types (`contract-info.json`), constructor arguments with a typed-JSON convention |
| `adapter.ts` | Contract adapters (witnesses, private state, argument mapping, publish calls for `deploy-and-publish`) |
| `records.ts`, `check.ts`, `contracts.ts` | midnight-js `deployContract` / `findDeployedContract().callTx`, a write-ahead journal on submission (hash, identifiers, TTL, contract address before the node sees the transaction), before-checks that skip completed work, reconciliation of an unknown outcome from the chain (never a blind resubmission), after-checks that mark a step completed only when the change is observed |

Tests: `test/*.test.ts` (unit, no chain; local-chain responses replayed from `test/fixtures/local/`, recorded by
`test/fixtures/record-local.ts` from a local stack after the end-to-end tests; the preprod / mainnet profiles against
an in-process Blockfrost stub). The end-to-end test on a local chain is `packages/cli/test/e2e/local-e2e.sh`.
