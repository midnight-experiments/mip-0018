# test-contracts/scanner-mints — TEST ONLY

`ScannerMints.compact` mints native tokens on a **local** chain so the S4 end-to-end test can check the mint scanner
(`mip0018 index`) and color lookup (`mip0018 lookup`):

| Circuit | What it does |
|---|---|
| `mintUnshielded(domainSep, amount)` | mints an unshielded token (kind 2) to the contract itself |
| `mintShielded(domainSep, amount, nonce, recipient)` | mints a shielded token (kind 1) to a coin public key |
| `publishMetadata(domainSep, kind, symbol4)` | emits a MIP-0018 event for `(domainSep, kind)`, kind 1 or 2, with `symbol` and `decimals` 2 |

Every circuit is unguarded: never deploy this contract outside a local test chain. Compile with
`docker/run.sh exec 'npm run compile -w test-contracts/scanner-mints'` (Compact 0.35.0, `--feature-zkir-v3`).
