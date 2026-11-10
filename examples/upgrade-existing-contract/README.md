# examples/upgrade-existing-contract — add `publishMetadata()` to a deployed token

MIP-0018, "Backwards Compatibility Assessment — Existing contracts" (Implementation Plan step 5): a
token deployed without an emitting circuit gets `publishMetadata()` through a maintenance
`VerifierKeyInsert` — same contract address, same `domainSep`, same color, same coins. The full
procedure, its checks and its limits: **[`docs/upgrade-guide.md`](../../docs/upgrade-guide.md)**.

| Path | What |
|---|---|
| [`legacy/LegacyToken.compact`](legacy/LegacyToken.compact) | the **deployed** token: native shielded (kind 1), an owner (`ownerSecret` witness → `ownerId`) who mints coins of color `tokenType(domain, address)`, **no MIP-0018 circuit**; its maintenance authority is the deploy-time key |
| [`upgrade/LegacyTokenMetadata.compact`](upgrade/LegacyTokenMetadata.compact) | the **upgrade-only source**: the same four ledger declarations verbatim + `publishMetadata()` (owner check reused; typed constructor `commonFields<12, 4>(domain, KIND_SHIELDED_UTXO, "Legacy Token", "LGCY", 6)`) — compiled only for its verifier key, never deployed |
| [`legacy/`, `upgrade/mip0018.adapter.ts`](src/adapters.ts) | `mip0018` adapters: witnesses and the owner secret (kept only in the signer's 0600 private-state file) |
| [`scripts/check-layout.ts`](scripts/check-layout.ts) | compares the compiler's ledger layouts of the two sources field by field; exit 1 on any difference |
| [`scripts/inspect.ts`](scripts/inspect.ts) | wallet-free view of a deployed contract: entry points + verifier-key hashes, maintenance authority, ledger-data hash, decoded fields |
| [`scripts/local-upgrade.sh`](scripts/local-upgrade.sh) | the local end-to-end proof (below) |
| [`test/`](test) | layout check (12 cases) and the upgrade against the deployed state in compact-runtime (9 cases) |

## The commands

```sh
# 0. build both with keys (Compact 0.36.0) and check the layout
docker/run.sh exec 'npm run -s compile -w examples/upgrade-existing-contract && npm run -s check-layout -w examples/upgrade-existing-contract'

# 1. the token as it was deployed long ago (no MIP-0018 circuit), and a mint
docker/signer.sh mip0018 -- deploy  --network <id> --adapter examples/upgrade-existing-contract/legacy/mip0018.adapter.ts \
  --args '["0x<domainSep>"]' --record <record>
docker/signer.sh mip0018 -- call    --network <id> --record <record> --circuit mint \
  --args '[{"bytes": "0x<coin public key>"}, 1000, "0x<32-byte nonce>"]'

# 2. the upgrade: preflight → VerifierKeyInsert(publishMetadata, v4) → publishMetadata()
docker/signer.sh mip0018 -- upgrade --network <id> --record <record> \
  --source examples/upgrade-existing-contract/upgrade --circuit publishMetadata

# 3. what consumers see (wallet-free)
docker/run.sh mip0018 -- check-event --network <id> --contract <address> --tx <publish tx> --expect '{"metadata": {…}}'
docker/run.sh mip0018 -- list   --network <id> --contract <address>
```

## Local run

`scripts/local-upgrade.sh` on the local chain (official `midnight-node` 2.1.101, `indexer-standalone` 4.4.101, one
`proof-server` 9.0.1; client `ledger-v9` 1.0.1), 2026-11-09, the dev chain's public genesis wallet: **44 PASS / 0 FAIL**.

| Step | Result | Fee (DUST) |
|---|---|---:|
| deploy `LegacyToken` (domainSep `0x5e…5e`) | contract `7676c4e0…ab25a036`, block 357; entry points `{mint}`, authority 1 key / threshold 1 / counter 0 | 1.277 |
| owner `mint` 1000 to wallet A | block 361; no `Misc` event; wallet A holds 1000 of color `11b3e70e…392b26ba` = `rawTokenType(domainSep, address)` | 0.265 |
| insert signed by a key outside the committee | refused by `mip0018 upgrade` before submission; forced: **rejected by the node** (`1010: Invalid Transaction: Custom error: 135`, `InvalidCommitteeSignature`), nothing changed | 0 |
| **`VerifierKeyInsert(publishMetadata, v4)`** | block 368, `SUCCESS`; entry points `{mint, publishMetadata}`; mint key unchanged; counter 1; **ledger data hash unchanged** | 0.804 |
| **`publishMetadata()`** through the upgrade build | block 372; one event bound to the original address; `check-event` (kind 1, "Legacy Token", "LGCY", 6) exit 0; `list`: identity color = the held coin's color | 0.194 |
| holder's view | wallet A still holds 1000 of that color; the mint scanner shows it minted before the insert; `lookup` of the color → the new metadata | — |
| re-insert the same key / another build's key | both refused before submission; forced: **`PARTIAL_SUCCESS`** (ledger: no overwrite), key, counter and data unchanged, still one event | 0.812 / 0.819 |
| the same command again, a new run, `publish` again | every step skipped by its before-check; no transaction | 0 |

The local chain is discarded after the run; the script writes every identifier (transactions, blocks, fees,
colors, key hashes) to `$MIP0018_E2E_DIR/summary.json` and its checks to `results.txt`. Unit and runtime tests:
`docker/run.sh exec 'npx vitest run examples/upgrade-existing-contract packages/midnight/test/upgrade-units.test.ts'`
(21 + 9).

## Preview run (case U1)

The same steps on preview, 2026-11-09, wallet 1 of this repository (only the free negatives: the paid overwrite
attempts above are not repeated there). Commands, record and observations:
[`deployments/preview/cases/U1`](../../deployments/preview/cases/U1/README.md); re-check without a wallet:
`docker/run.sh mip0018 -- recheck --network preview --case deployments/preview/cases/U1`.

| Step | Result | Fee (DUST) |
|---|---|---:|
| deploy `LegacyToken` (domainSep `pad(32, "mip-0018:example:upgrade")`) | contract `783fd16b82e6ce98381bf7a19d458f8bb179b6612984ef6f64c5cfbf2eab453a`, tx `46d13d03…720b32f6`, block 42130; entry points `{mint}` (key `b1dbe2b7…e53d`), authority 1 key / threshold 1 / counter 0 | 1.892 |
| owner `mint` 1000 to wallet 1 | tx `90a07830…94e6392a`, block 42136; wallet 1 holds 1000 of color `110b4cf8aad92cebf85555196c46dfc1ac8ca15698ec77d2ab198cf0633b704a` | 0.282 |
| insert signed by a key outside the committee | refused before submission (no transaction); forced: **rejected by the node** (`1010: Invalid Transaction: Custom error: 135`), not included | 0 |
| **`VerifierKeyInsert(publishMetadata, v4)`** | tx `bf66f3f1…b5a91ec6`, block 42148, `SUCCESS`; entry points `{mint, publishMetadata}` (key `fd630482…e1fc`), mint key unchanged, counter 1, **ledger data hash unchanged** (`9ca152f8…2e07`) | 1.167 |
| **`publishMetadata()`** through the upgrade build | tx `48f5a1ac…6d4883e3`, block 42153; one event bound to the original address; `check-event` exit 0; `list`: identity color = the held coins' color | 0.219 |
| holder's view | wallet 1 still holds 1000 of that color; the scanner (blocks 42129–42153) shows it minted at 42136, before the insert; `lookup` → "Legacy Token" / "LGCY" / 6 | — |
