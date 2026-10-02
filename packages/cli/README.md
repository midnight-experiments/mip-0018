# `mip0018` — the MIP-0018 reference CLI

Run it in the pinned image: wallet-free commands with `docker/run.sh mip0018 -- <command> …`, signing commands with
`docker/signer.sh mip0018 -- <command> …` (the only container that mounts a secret, read-only). `<command> --help`
prints the details; every command has `--json`.

| Command | Wallet | What it does |
|---|---|---|
| `verify --network <id> --contract <addr> --tx <hash> [--expect <json>]` | no | The contract's Misc event(s) in that transaction: name, binding (address from the event record), decode → accept / reject / ignore with the reason, raw-transaction cross-check (hash, identifiers, same bytes in a log op, zero-extended to 288), node block hash, finality, raw bytes in the block's extrinsic, optional expectation |
| `list --network <id> --contract <addr> [--to-block <h>] [--history]` | no | Every MIP-0018 event of the contract in chain order and the current metadata per token identity (visibility, usable fields, colors for kinds 1/2, symbol groups, source events); refuses rather than truncates |
| `index --network <id> --from-height <h> [--to-height <h> \| --follow] --state <dir>` | no | The mint scanner: color → (contract, domainSep, kinds, first mint), MIP-0018 events and deploys of the range; resumable |
| `lookup --color <hex> --state <dir> [--kind 1\|2] [--network <id>]` | no | Color → identity → metadata (live with `--network`, otherwise from the scan); "not minted in the scanned range [from, to]" otherwise; kind 3 has no color |
| `vectors run [--consumer "<cmd>"]` | no | The language-neutral vector runner (default: the reference consumer) |
| `wallet status` · `wallet register-dust [--estimate]` | yes | Public addresses and balances · DUST registration (skipped when already registered) |
| `deploy (--contract <managed dir> \| --adapter <file> \| --example <name>) --record <file> [--args <json>]` | yes | midnight-js `deployContract` with a run record and before/after checks |
| `publish --record <file> --circuit <name> [--args <json>] [--step <id>] [--force]` (`call` = alias) | yes | `findDeployedContract().callTx.<circuit>()`; skipped when the metadata already holds exactly what it would set |
| `remove-circuit --record <file> --circuit <name>` | yes | Create-and-destroy: `VerifierKeyRemove` in the `v4` slot (Q23) |
| `deploy-and-publish --example <name> [--metadata <json>] --record <file>` | yes | compile → deploy → publish → verify, each step guarded |

Exit codes: 0 ok · 1 mismatch, failed or refused · 2 usage · 3 not found / not minted in range · 4 not yet indexed /
outcome unknown (re-run to reconcile).

Networks: `--network stagenet` uses the pinned public endpoints (rate-bounded) and checks the pinned genesis;
`--network undeployed` needs `--indexer`/`--rpc` (or `MIP0018_INDEXER_URL` / `MIP0018_NODE_URL`) and refuses public
hosts. Signing needs the two official proof servers (`--proof-server` for contract circuits, `--wallet-proof-server`
for DUST spends; Q21), a wallet secret file (`--mnemonic-file`; on a local chain also `--seed-file` or
`--dev-genesis-wallet`) and a private state directory outside the repository (`--state-dir`).

Records are public JSON (contract address, transactions, observations — never a secret). Maintenance keys and
witness private state (e.g. an `Ownable` owner secret) are in `<state-dir>/mip0018-private-state.json` (0600).

End-to-end test on a local chain: `MIP0018_DOCKER_PREFIX=… MIP0018_E2E_DIR=<dir outside the repo>
packages/cli/test/e2e/local-e2e.sh`.
