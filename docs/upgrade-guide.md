# Upgrade guide — add MIP-0018 metadata to an already-deployed contract

MIP-0018, "Backwards Compatibility Assessment — Existing contracts": a contract deployed without an
emitting circuit does not need redeployment; its **maintenance authority** can add one.

1. Compile a `publishMetadata()` circuit against the contract's existing ledger layout. It reads the
   existing `domain` from state and emits it as `domainSep`.
2. Add its verifier key with a `VerifierKeyInsert` maintenance update signed by the maintenance authority.
3. Call it.

This guide is the operational form of those three steps. The template is
[`examples/upgrade-existing-contract`](../examples/upgrade-existing-contract) (a native shielded token
deployed without any MIP-0018 circuit, and the upgrade-only source that adds `publishMetadata()`); the
tool is `mip0018 upgrade` ([`packages/cli`](../packages/cli)). Everything below was run on the local
chain (official images, [`docker/local-stack`](../docker/local-stack)); the Stagenet case is U1 in
[`deployments/stagenet`](../deployments/stagenet) (recorded after the Stagenet matrix).

## What changes and what does not

| | After the upgrade | Why |
|---|---|---|
| Contract address | **same** | nothing is deployed; the event is bound to the original address |
| `domainSep` | **same** | `publishMetadata()` reads it from the deployed state |
| Color of every coin ever minted | **same** | `tokenType(domainSep, address)` — both unchanged |
| Coins, balances, every ledger field | **unchanged** | a maintenance update touches only entry points and the authority counter; the template's run hashes the ledger data before and after: equal |
| Entry points | `+ publishMetadata` (with the inserted verifier key) | the `VerifierKeyInsert` |
| Maintenance authority counter | `+1` per applied update | replay protection |
| Existing circuits (`mint`, …) | **unchanged**, same verifier keys | an insert never touches another entry point |

A consumer sees an ordinary MIP-0018 event of the original contract: the identity
`(network, contractAddress, domainSep, kind)` is the one every holder's coins already belong to, and
the color it derives is the color of coins minted long before the upgrade. Nothing has to migrate on
the consumer side.

## Before you start — can this contract be upgraded?

Check the deployed contract first (wallet-free):

```sh
docker/run.sh exec 'node examples/upgrade-existing-contract/scripts/inspect.ts --network stagenet --contract <address>'
```

It prints the entry points (with the SHA-256 of each verifier key), the maintenance authority
(committee size, threshold, counter) and the SHA-256 of the ledger data.

1. **A usable maintenance authority.** The committee must not be empty and its threshold must be
   reachable (≤ committee size, and you must hold that many keys; `mip0018 upgrade` signs with one key,
   so threshold 1). A contract with an **empty committee — the ledger's default, a "frozen" authority —
   can never take a maintenance update**: it cannot adopt MIP-0018 without redeployment (and a
   migration of its holders, since a new address means a new color). midnight-js `deployContract`
   always installs a one-key committee (the `signingKey` you pass, or a sampled one it stores in its
   private-state provider); if that key is lost, the authority is frozen in practice. `mip0018 deploy`
   keeps it in the signer's 0600 private-state file.
2. **The deployed source**, exactly: its ledger declarations, the modules it imports (and their
   versions), and ideally its compiler output (`compiler/contract-info.json`).
3. **Where `domainSep` lives.** It must be a ledger field (for example the template's `domain`, or
   OpenZeppelin `NativeShieldedToken`'s `_domain`). If the contract never stored it (for example a
   token family that takes the domain per mint), the new circuit has to take it as a parameter — then it
   must be access-controlled, never unguarded.
4. **Access control the new circuit can reuse.** An upgrade cannot add ledger fields (next section), so
   a publish-once flag is impossible. Reuse what the contract has (an owner field and its witness, as
   the template does), or make the payload constant and remove the key right after the call
   (create-and-destroy, [`examples/minimal`](../examples/minimal)).

## Step 1 — write an upgrade-only source

[`upgrade/LegacyTokenMetadata.compact`](../examples/upgrade-existing-contract/upgrade/LegacyTokenMetadata.compact)
for [`legacy/LegacyToken.compact`](../examples/upgrade-existing-contract/legacy/LegacyToken.compact):

```compact
import CompactStandardLibrary;
import "../../../packages/compact/src/Mip0018" prefix Mip0018_;   // declares no ledger field

// ---- copied VERBATIM from the deployed source: same fields, order, types ----
export sealed ledger domain: Bytes<32>;
export ledger owner: Bytes<32>;
export ledger totalMinted: Uint<128>;
export ledger mintCount: Counter;

witness ownerSecret(): Bytes<32>;                                   // the deployed contract's own witness
pure circuit ownerId(secret: Bytes<32>): Bytes<32> { … }            // and its own account-id derivation

export circuit publishMetadata(): [] {
  assert(ownerId(ownerSecret()) == owner, "LegacyToken: caller is not the owner");
  Mip0018_emitPayload(Mip0018_commonFields<12, 4>(domain, Mip0018_KIND_SHIELDED(), "Legacy Token", "LGCY", 6));
}
```

Rules:

- **Same ledger layout.** Compact gives each ledger field — the contract's own and those of every
  imported module — a state path by declaration order. A circuit reads and writes the deployed state
  through the paths of the source it was compiled from. Copy the declarations verbatim, including the
  module imports that declare ledger fields, in the same order. Do not add, remove, rename, reorder or
  retype anything. A module you import only for the new circuit must declare no ledger field
  (`Mip0018` declares none).
- **Export only the circuit(s) you insert.** midnight-js `findDeployedContract` refuses a compiled
  contract whose circuits are not all on chain with byte-identical verifier keys. Compiling the whole
  contract again would also produce keys for the old circuits, which differ as soon as the compiler
  differs; the upgrade-only source avoids both problems. (Compact compiles every exported circuit;
  there is no per-circuit flag.)
- **The value of `domainSep` comes from the state**, never from a literal you retype: the color is
  derived from it.
- **Compile with keys** (not `--skip-zk`): the verifier key is what you insert. The template uses
  Compact 0.35.0 with `--feature-zkir-v3` (`publishMetadata` here: k = 15, 17,683 rows).

## Step 2 — check the layout (before anything is signed)

```sh
docker/run.sh exec 'npm run -s check-layout -w examples/upgrade-existing-contract'
#   --legacy <deployed source or its managed dir>  --upgrade <upgrade source or managed dir>
```

[`scripts/check-layout.ts`](../examples/upgrade-existing-contract/scripts/check-layout.ts) compares the
**compiler's own record of the layout** (`compiler/contract-info.json` → `ledger`: name, index,
storage, type — compactc 0.35.0 writes it, including imported modules' fields) field by field, and
exits 1 on any difference: reordered, renamed, retyped, missing or extra fields, another storage kind,
or an imported module that brings ledger fields. `export`/`sealed` are reported but do not change
places. `mip0018 upgrade` runs the same comparison, plus an on-chain check: it decodes the **deployed
state** through the deployed build's and the upgrade build's `ledger()` accessors and refuses when any
field differs.

Why this matters — nothing on chain catches it. In the template's tests
([`test/upgrade.test.ts`](../examples/upgrade-existing-contract/test/upgrade.test.ts)) an upgrade source
with `domain` and `owner` swapped (both `Bytes<32>`) compiles. Its owner check then reads the domain,
so the owner is refused — the lucky case. Without the owner check, the same source **silently
publishes a valid event for `domainSep` = the owner's id**: metadata for an identity nobody holds,
while the real token stays undescribed.

If the deployed contract was built by another compiler, compare against its original build (its
`managed` directory) when you have it; the on-chain decode check still applies.

## Step 3 — insert the verifier key, then call

```sh
docker/signer.sh mip0018 -- upgrade --network <id> --record <the contract's run record> \
  --source examples/upgrade-existing-contract/upgrade --circuit publishMetadata [--maintenance-key-file <0600 file>]
```

`mip0018 upgrade` (each step recorded in the run record; re-run the command to resume):

1. **Preflight** (reads only): the circuit is built with keys; every other provable circuit of the
   upgrade build is already on chain with the same key; layouts identical; the deployed state decodes
   identically through both builds.
2. **`VerifierKeyInsert`** of `keys/publishMetadata.verifier`, signed by the maintenance key (the
   deploy-time key from the signer's private-state file, or `--maintenance-key-file`: JSON
   `{"tag": "schnorr", "value": "<hex>"}` or hex, mode 0600). Before submitting it refuses — nothing
   spent — when the key cannot sign for the contract's authority (frozen, not in the committee,
   threshold > 1) or when the circuit already has another key. It skips the insert when the circuit
   already has exactly this key (a re-run).
3. **The call**, through the upgrade build (midnight-js `findDeployedContract(...).callTx.publishMetadata()`),
   with the before/after checks of `mip0018 publish`. Later `mip0018 publish --record … --circuit
   publishMetadata` calls find the upgrade build in the record.

Facts the tool relies on (ledger v9, `midnight-ledger` 9.1.0.0-rc.3):

- **Key versions.** A contract operation keeps verifier keys in versioned slots: `v3` for ZKIR v2
  circuits (the Compact default) and `v4` for ZKIR v3 circuits (`--feature-zkir-v3`). Insert at the
  version of the circuit's proving system; a mismatch is included but fails. midnight-js 5.0.0-rc.2's
  `insertVerifierKey()` / `submitInsertVerifierKeyTx` always write `v3`, so the tool builds the
  `MaintenanceUpdate` itself with the right version and submits it through midnight-js `submitTx`
  (questions Q23; proposal note N5). Old circuits keep their own slot: a contract may hold `v3` keys
  for its original circuits and a `v4` key for the new one.
- **Authority and counter.** The update carries the authority's current counter and enough committee
  signatures (each at its committee index); an applied update increments the counter.
- **Fallible segment.** Maintenance updates apply only in a fallible segment: a refused update is still
  included and its fee paid.
- **No overwrite.** `VerifierKeyInsert` never replaces a key already present in that slot
  (`VerifierKeyAlreadyPresent`). Replacing a circuit takes a `VerifierKeyRemove` and then an insert.
- **Insert before anything touches it.** Until the key is on chain, `findDeployedContract` with the
  upgrade build refuses the contract (the circuit is missing).

## Step 4 — check what consumers see

```sh
docker/run.sh mip0018 -- verify --network <id> --contract <address> --tx <publish tx> \
  --expect '{"metadata":{"domainSep":"0x…","kind":1,"name":"Legacy Token","symbol":"LGCY","decimals":6}}'
docker/run.sh mip0018 -- list   --network <id> --contract <address>          # identity, fields, color
docker/run.sh mip0018 -- index  --network <id> --from-height <h> --state <dir>   # mint scanner
docker/run.sh mip0018 -- lookup --color <a held coin's color> --state <dir>  # → the new metadata
```

`list` derives the identity's color as `tokenType(domainSep, address)`; it equals the color a holder's
wallet shows for coins minted before the upgrade (`mip0018 wallet status` lists shielded balances by
color), and `lookup` resolves that color to the metadata published after the upgrade.

## Limits

| Limit | Consequence |
|---|---|
| Frozen maintenance authority (empty committee, unreachable threshold, lost key) | No maintenance update is possible: no `publishMetadata()` without redeployment |
| Threshold > 1 | Needs that many committee signatures on one update; `mip0018 upgrade` signs with one key (collect the others with the ledger API) |
| Ledger layout must be identical | The upgrade source repeats every ledger declaration verbatim; a mismatch is invisible on chain (see Step 2) |
| No new ledger fields | No publish-once flag; reuse existing access control, or constant payload + remove the key after the call |
| Key versions | Insert at the slot of the circuit's proving system (`v4` for ZKIR v3); midnight-js 5.0.0-rc.2 writes only `v3` (Q23, N5) |
| No overwrite | An existing `publishMetadata` must be removed first; the ledger refuses an insert over it (see the run below) |
| One circuit per run | The tool inserts one circuit per `upgrade` run (the ledger accepts several `SingleUpdate`s in one update); export only inserted circuits from the upgrade source |
| Trust | The maintenance authority can remove and insert **any** circuit at any time — including `publishMetadata` and the token's own circuits. Whoever holds it controls the token's metadata as much as the owner check does |
| Contracts deployed under ledger 8 (before Midnight 2.x) | Not exercised here: the local chain and Stagenet run ledger v9 from genesis. midnight-js 5 has a separate pipeline for such ("retained era") contracts; whether they accept a `v4` (ZKIR v3) key insert and call is unverified |

## Run the template locally

```sh
# runtime tests, no chain: layout check (12 mutations), the upgrade against the deployed state (9)
docker/run.sh exec 'npx vitest run examples/upgrade-existing-contract'

# end to end on the local chain: deploy → mint → wrong signer (refused, rejected) → upgrade → verify/list/
# index/lookup → no-overwrite (refused before submission, refused by the ledger) → idempotent re-runs
MIP0018_DOCKER_PREFIX=<prefix> MIP0018_E2E_DIR=<empty dir outside the repo> \
  examples/upgrade-existing-contract/scripts/local-upgrade.sh
```

Local results: [`examples/upgrade-existing-contract/README.md`](../examples/upgrade-existing-contract/README.md#local-run).
