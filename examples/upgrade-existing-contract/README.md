# examples/upgrade-existing-contract — add `publishMetadata()` to a deployed token

MIP-0018, "Backwards Compatibility Assessment — Existing contracts" (Implementation Plan step 5): a
token deployed without an emitting circuit gets `publishMetadata()` through a maintenance
`VerifierKeyInsert` — same contract address, same `domainSep`, same color, same coins. The full
procedure, its checks and its limits: **[`docs/upgrade-guide.md`](../../docs/upgrade-guide.md)**.

| Path | What |
|---|---|
| [`legacy/LegacyToken.compact`](legacy/LegacyToken.compact) | the **deployed** token: native shielded (kind 1), an owner (`ownerSecret` witness → `ownerId`) who mints coins of color `tokenType(domain, address)`, **no MIP-0018 circuit**; its maintenance authority is the deploy-time key |
| [`upgrade/LegacyTokenMetadata.compact`](upgrade/LegacyTokenMetadata.compact) | the **upgrade-only source**: the same four ledger declarations verbatim + `publishMetadata()` (owner check reused; typed constructor `commonFields<12, 4>(domain, KIND_SHIELDED, "Legacy Token", "LGCY", 6)`) — compiled only for its verifier key, never deployed |
| [`legacy/`, `upgrade/mip0018.adapter.ts`](src/adapters.ts) | `mip0018` adapters: witnesses and the owner secret (kept only in the signer's 0600 private-state file) |
| [`scripts/check-layout.ts`](scripts/check-layout.ts) | compares the compiler's ledger layouts of the two sources field by field; exit 1 on any difference |
| [`scripts/inspect.ts`](scripts/inspect.ts) | wallet-free view of a deployed contract: entry points + verifier-key hashes, maintenance authority, ledger-data hash, decoded fields |
| [`scripts/local-upgrade.sh`](scripts/local-upgrade.sh) | the local end-to-end proof (below) |
| [`test/`](test) | layout check (12 cases) and the upgrade against the deployed state in compact-runtime (9 cases) |
| [`MIP-PROPOSAL-NOTES.md`](../../MIP-PROPOSAL-NOTES.md) (N5, N15–N18) | what this template suggests for the MIP text |

## The commands

```sh
# 0. build both with keys (Compact 0.35.0, --feature-zkir-v3) and check the layout
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
docker/run.sh mip0018 -- verify --network <id> --contract <address> --tx <publish tx> --expect '{"metadata": {…}}'
docker/run.sh mip0018 -- list   --network <id> --contract <address>
```

## Local run

`scripts/local-upgrade.sh` on the local chain (official `midnight-node` 2.0.0-rc.4, indexer 4.4.0-rc.1,
proof servers 9.0.0-rc.8 / rc.6), 2026-10-02, the dev chain's public genesis wallet: **44 PASS / 0 FAIL**.

| Step | Result | Fee (DUST) |
|---|---|---:|
| deploy `LegacyToken` (domainSep `0x5e…5e`) | contract `34446d4b…4023f58`, entry points `{mint}`, authority 1 key / threshold 1 / counter 0 | 0.928 |
| owner `mint` 1000 to wallet A | no `Misc` event; wallet A holds 1000 of color `16f0bc7f…f432c688` = `rawTokenType(domainSep, address)` | 0.237 |
| insert signed by a key outside the committee | refused by `mip0018 upgrade` before submission; forced: **rejected by the node** (`1010: Invalid Transaction: Custom error: 135`, `InvalidCommitteeSignature`), nothing changed | 0 |
| **`VerifierKeyInsert(publishMetadata, v4)`** | `SUCCESS`; entry points `{mint, publishMetadata}`; mint key unchanged; counter 1; **ledger data hash unchanged** | 0.592 |
| **`publishMetadata()`** through the upgrade build | one event bound to the original address; `verify` (kind 1, "Legacy Token", "LGCY", 6) exit 0; `list`: identity color = the held coin's color | 0.165 |
| holder's view | wallet A still holds 1000 of that color; the mint scanner shows it minted before the insert; `lookup` of the color → the new metadata | — |
| re-insert the same key / another build's key | both refused before submission; forced: **`PARTIAL_SUCCESS`** (ledger: no overwrite), key, counter and data unchanged, still one event | 0.599 / 0.605 |
| the same command again, a new run, `publish` again | every step skipped by its before-check; no transaction | 0 |

## Stagenet run (case U1)

The same steps on Stagenet, 2026-10-02, wallet 1 of this repository (only the free negatives: the paid overwrite
attempts above are not repeated there). Commands, record and observations:
[`deployments/stagenet/cases/U1`](../../deployments/stagenet/cases/U1/README.md); re-check without a wallet:
`docker/run.sh mip0018 -- recheck --network stagenet --case deployments/stagenet/cases/U1`.

| Step | Result | Fee (DUST) |
|---|---|---:|
| deploy `LegacyToken` (domainSep `pad(32, "mip-0018:example:upgrade")`) | contract `11010832a39954d9ccce48f6b5fce25fc789abb1d700ee45b26b69af3e5dd63b`, block 715403; entry points `{mint}`, authority 1 key / threshold 1 / counter 0 | 1.456 |
| owner `mint` 1000 to wallet 1 | block 715409; wallet 1 holds 1000 of color `89a5559202e2d7c111150d84bbcae4c4beb56733373e1935ac74ce565f17ffb0` | 0.219 |
| insert signed by a key outside the committee | refused before submission (no transaction); forced: **rejected by the node** (`1010: Invalid Transaction: Custom error: 135`), not included | 0 |
| **`VerifierKeyInsert(publishMetadata, v4)`** | tx `4383f3cd…1d1ff2`, block 715428, `SUCCESS`; entry points `{mint, publishMetadata}`, mint key unchanged, counter 1, **ledger data hash unchanged** | 0.911 |
| **`publishMetadata()`** through the upgrade build | tx `884cc30b…4c85124`, block 715433; one event bound to the original address; `verify` exit 0; `list`: identity color = the held coins' color | 0.176 |
| holder's view | wallet 1 still holds 1000 of that color; the scanner (blocks 715402–715433) shows it minted at 715409, before the insert; `lookup` → "Legacy Token" / "LGCY" / 6 | — |

The local chain is discarded after the run; the script writes every identifier (transactions, blocks, fees,
colors, key hashes) to `$MIP0018_E2E_DIR/summary.json` and its checks to `results.txt`. Unit and runtime tests:
`docker/run.sh exec 'npx vitest run examples/upgrade-existing-contract packages/midnight/test/upgrade-units.test.ts'`
(21 + 9).
