# `@mip0018/midnight`

Chain access for the MIP-0018 scripts on Midnight 2.x (ledger v9; indexer 4.4.0-rc.1, the schema Stagenet serves).
Two entry points:

| Entry | For | Never touches |
|---|---|---|
| `@mip0018/midnight` | anyone: verify an emission, list a contract's metadata, scan mints, look up colors | wallets, secrets |
| `@mip0018/midnight/signer` | the issuer (signer container only): wallet session, deploy / call / verifier-key removal with run records and before/after checks | — |

## Wallet-free (`src/`)

| Module | What it does |
|---|---|
| `network.ts` | Profiles: `stagenet` (endpoints + genesis pinned, `toolchain.json`) and `undeployed` (every URL required, never a default; public hosts and the Stagenet genesis refused). `checkIdentity` = `chain_getBlockHash(0)` against the profile |
| `http.ts` | JSON over HTTP: timeout, bounded retries (408/425/429/5xx, `Retry-After`), minimum interval between requests (public endpoints: 250 ms) |
| `rpc.ts` | Node RPC: block hash, finalized head, header, block extrinsics (raw-transaction presence), versions |
| `indexer.ts` | GraphQL v4 — the only module that knows the `@beta` contract-event surfaces: tip, transaction by hash, a contract's Misc events paged until an **empty** page (no silent truncation), the verify bundle (events + transaction + tip in one request), contract state, block / `blocks` subscription for the scanner |
| `ws.ts` | Minimal `graphql-transport-ws` client (Node's global WebSocket) |
| `raw.ts` | ledger-v9 decoding of a raw transaction: hash, identifiers, deploys, maintenance updates, every `log` op (Misc data zero-extended to 288 bytes) and mint effect in ledger order; which parts were applied (guaranteed unless FAILURE; fallible only in a successful segment); event envelopes (`midnight:event[v14]`) |
| `color.ts` | `tokenType(domainSep, contractAddress)` with ledger-v9 `rawTokenType` (+ an independent SHA-256 derivation used in tests) |
| `verify.ts` | One emission: indexer event, name, binding from the event record, classification (accept / reject / ignore + reason), raw-transaction cross-check, node block hash, finality, extrinsic presence, optional expectation. Outcomes ok / mismatch / not-found / not-indexed |
| `list.ts` | All MIP-0018 events of a contract reduced with `@mip0018/consumer` (colors injected for kinds 1 and 2) |
| `scanner.ts` | The mint scanner (owner decision F8): from a start height, every block → contract calls' raw transactions → applied `shieldedMints` / `unshieldedMints` → `color → (contract, domainSep, kinds, first mint)`, plus every MIP-0018 event and every deploy; atomic checkpoint after each block; resumable; `lookupColor` |

## Signer (`src/signer/`)

| Module | What it does |
|---|---|
| `secrets.ts` | Secrets only from file paths (regular file, mode ≤ 0600, no symlink); BIP-39 mnemonic → seed; hex seeds for local test wallets |
| `wallet.ts` | Wallet SDK 2.0.0-beta.2 behind midnight-js 5.0.0-rc.2 providers (Q22); complete sync (3 consecutive strictly-complete samples); DUST registration without double signing; `feeBlocksMargin` 5 |
| `providers.ts` | midnight-js providers for a compiled contract; the contract-circuit proof server wrapped with ≤ 4 concurrent proofs and retries on 408/429/502/504 |
| `private-state.ts` | 0600 file for maintenance keys and witness private state (typed JSON for bytes and bigints) |
| `maintenance.ts` | `VerifierKeyRemove` / `VerifierKeyInsert` in the `v4` slot for ZKIR-v3 circuits (Q23), submitted with midnight-js `submitTx` |
| `args.ts` | `--args` JSON → runtime values: circuit arguments with the compiler's types (`contract-info.json`), constructor arguments with a typed-JSON convention |
| `adapter.ts` | Contract adapters (witnesses, private state, argument mapping, publish calls for `deploy-and-publish`) |
| `records.ts`, `check.ts`, `contracts.ts` | Q13 (b): midnight-js `deployContract` / `findDeployedContract().callTx`, a write-ahead journal on submission (hash, identifiers, TTL, contract address before the node sees the transaction), before-checks that skip completed work, reconciliation of an unknown outcome from the chain (never a blind resubmission), after-checks that mark a step completed only when the change is observed |

Tests: `test/*.test.ts` (unit, no chain; Stagenet responses replayed from `test/fixtures/stagenet/`, recorded by
`test/fixtures/record-stagenet.ts`). The end-to-end test on a local chain is `packages/cli/test/e2e/local-e2e.sh`.
Notes for the MIP text found while building this: `PROPOSED-MIP-NOTES.md`.
