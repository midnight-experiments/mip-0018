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
| [`PROPOSED-MIP-NOTES.md`](PROPOSED-MIP-NOTES.md) | what this template suggests for the MIP text (staging for the root `MIP-PROPOSAL-NOTES.md`) |

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

Filled in from `scripts/local-upgrade.sh` (see the S6 plan for the run log).
