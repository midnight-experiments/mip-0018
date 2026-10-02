# Issuer guide — publish MIP-0018 metadata for your token

How a token contract publishes its name, symbol and decimals as MIP-0018 events
([MIP-0018 @ `78ecbb4b`](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/78ecbb4b1ba57371e84fe45f705991ab7b996a61/mips/mip-0018-on-chain-token-metadata.md)):
what to emit, the Compact lines to add, who may call them, and how to deploy, publish, rename and withdraw with the
`mip0018` CLI. Everything shown was run on a local chain and on Stagenet; the commands are copied from the
walkthroughs [`examples/publish-and-emit`](../examples/publish-and-emit/README.md) and
[`examples/verify`](../examples/verify/README.md) or from the Stagenet case folders. The reader side is the
[consumer guide](consumer-guide.md).

Toolchain: MIP-0018 needs MIP-0002 `Misc` events, so **Compact 0.34.0 or later**; this repository builds and tests with
**Compact 0.35.0 and `--feature-zkir-v3`** ([`toolchain.json`](../toolchain.json)), all inside the pinned Docker image.

## 1. What to publish

One event describes one **token identity** `(contractAddress, domainSep, kind)`:

| `kind` | Token | `domainSep` | Color |
|---:|---|---|---|
| 1 | native shielded (coins) | the value your contract passes to `mintShieldedToken` | `tokenType(domainSep, contractAddress)` |
| 2 | native unshielded (UTXOs) | the value passed to `mintUnshieldedToken` | the same formula |
| 3 | ledger token (balances in contract state) | any stable 32 bytes you choose, e.g. `pad(32, "acme:gold")` | none |

The contract address is never in the payload: consumers take it from the event record, so a contract can only describe
its own tokens. For a native token the `domainSep` **must** be the minting value — read it from the same ledger field
the mint uses — or the color consumers derive will not be the color of your coins. One asset held in several forms
(shielded, unshielded, ledger) is several identities: publish one event per kind
([`examples/openzeppelin/multi-kind`](../examples/openzeppelin/multi-kind/README.md)).

What to put in the event:

- **`name`, `symbol`, `decimals`** (SHOULD) — non-empty UTF-8, non-empty UTF-8, and `decimals` as a `Uint<8>`.
  Consumers assume no default: a token without `decimals` shows no amounts.
- **`standards`** (MAY) — standards the token claims, as `mip-NNNN` identifiers separated by single spaces. Claim only
  what the token implements: the OpenZeppelin examples publish none, because OpenZeppelin claims no MIP (question Q25).
- **Exact bytes.** Keys and values are compared byte for byte. The MIP says it outright (Payload, since `78ecbb4`):
  "Each fixed-size field must be exactly as long as the key or value it carries: a shorter value padded with zero
  bytes is a different value (for example `"AGL"` sent as a `Bytes<4>` is `"AGL\0"`), and consumers accept it as such."
  Every size in the module is the value's UTF-8 byte length.
- **One event per identity.** The payload is 256 bytes: a 33-byte header, then records of `3 + key + value` bytes; the
  largest value is 219 bytes. The three common fields plus `standards` take 62 bytes (MIP Appendix A).
- **Getters.** If the token also exposes standard getters (for example MIP-0004/0011/0014 `name()` / `symbol()` /
  `decimals()`), publish the same values when you first publish. Nothing on chain checks this; the OpenZeppelin
  examples take both from one `metadata.json` and read `decimals` from the token state. "A later update, such as a
  rename, is the token's current metadata for consumers of this MIP even where the getters cannot change" (MIP Common
  fields, since `78ecbb4`) — OpenZeppelin's `sealed` getters keep the old values after a rename. A MIP that
  defines a token standard may restrict or override this for tokens that declare it in `standards`.

When to emit (MIP "Publishing"): once after deployment (a Compact constructor cannot emit), and for extraordinary
updates — a rename, a correction, a withdrawal. **Never from mint, transfer or burn.**

## 2. Add the circuits

The Compact module is [`packages/compact`](../packages/compact/README.md). Import it and add one circuit, conventionally
`publishMetadata()`:

```compact
import "@mip0018/compact/src/Mip0018" prefix Mip0018_;  // compile with --compact-path <repo>/node_modules,
                                                        // or import a relative path to src/Mip0018

export circuit publishMetadata(): [] {
  // guard it (owner check), make it publish-once, or remove its key after the first call
  Mip0018_emitPayload(Mip0018_commonFieldsWithStandards<10, 4, 8>(
    domain, Mip0018_KIND_LEDGER(), "Acme Token", "ACME", 6, "mip-0004"));
}
```

That is MIP test A1. The generic arguments are the byte lengths of `name`, `symbol` and `standards` (`"Acme Token"` is
`Bytes<10>`); a wrong length, an empty key, name or symbol, a value over 255 bytes, `decimals` above 255 or a payload
over 256 bytes is a **compile error**, and so is an `emit` in a constructor. Without `standards`, use
`Mip0018_commonFields<N, S>(domainSep, kind, name, symbol, decimals)`.

Rename and withdraw, from the [OpenZeppelin fungible token](../examples/openzeppelin/fungible-token/README.md)
(owner-only; a new name must be exactly as long as the circuit's `Bytes<N>`):

```compact
export circuit setMetadata(newName: Bytes<9>, newSymbol: Bytes<4>): [] {
  Ownable_assertOnlyOwner();
  Mip0018_emitPayload(Mip0018_payload2<4, 9, 6, 4>(
    Mip0018_header(metadataDomain(), Mip0018_KIND_LEDGER()),
    Mip0018_nameRecord<9>(newName),
    Mip0018_symbolRecord<4>(newSymbol)));
}

export circuit withdrawMetadata(): [] {
  Ownable_assertOnlyOwner();
  Mip0018_emitPayload(Mip0018_tombstone(metadataDomain(), Mip0018_KIND_LEDGER()));
}
```

A rename changes only the keys it carries; the tombstone withdraws the whole identity (consumers hide it and clear every
field; the next publish starts from nothing).

**Two constructions, same bytes** (owner decision Q3). The default module `Mip0018` builds typed records that Compact
serializes, so the compiler checks every size. The alternative `Mip0018Pure` composes the payload from individual
pure circuits with `Bytes[...]` spreads; it exists because it does not rely on `serialize` for non-event types. Both
emit identical bytes, equal to the vectors; the typed one is 1.3–1.5× smaller for runtime values (four runtime fields:
k = 15 vs 16), so use it unless you have a reason not to.

**What the compiler cannot check**: that a runtime UTF-8 value is valid UTF-8, a JSON value valid JSON, or a URI an
RFC 3986 `URI` (scheme required, ASCII only — question Q20). String literals are fine; validate runtime arguments off
chain before the call, e.g. with `@mip0018/codec`'s `encodePayload`, which throws on anything a consumer would reject.
A malformed event is rejected whole by every consumer.

Compile with keys (a deploy needs the verifier keys); for a contract of your own, in the pinned image:

```sh
docker/run.sh exec 'compact compile --feature-zkir-v3 --compact-path node_modules examples/openzeppelin/fungible-token/contracts/MyFungibleToken.compact managed/MyFungibleToken'
```

(source path and output directory are yours; `managed/` output is never committed — builds are deterministic, and
the verifier-key SHA-256s are in [`docs/costs.json`](costs.json) and [`examples/openzeppelin/costs.json`](../examples/openzeppelin/costs.json), question Q24). The examples have their own scripts,
e.g. `docker/run.sh exec 'npm run -s compile -w examples/openzeppelin -- --keys --with-metadata-only fungible-token'`.

## 3. Choose who may publish

Anyone who can call an emitting circuit can rename or withdraw the token, so the MIP says it "SHOULD be
access-controlled, publish-once, or removed after use" (Publishing; "removed after use" since `78ecbb4`; owner
decision Q4). Four patterns, all tested; sizes from [`docs/costs.md`](costs.md):

| Pattern | Example | Rename / withdraw later | `publishMetadata()` size | Caveats |
|---|---|---|---|---|
| OpenZeppelin `Ownable` | [`examples/openzeppelin`](../examples/openzeppelin/README.md) | yes, owner-only | fungible k = 13 (literal `domainSep`), native k = 15 | `Ownable_assertOnlyOwner()` first in every emitting circuit; the owner secret lives in the deployer's private state |
| Owner key (hand-rolled) | [`OwnerKey`](../examples/minimal/contracts/OwnerKey.compact) | yes, owner-only | k = 15, 17,782 rows | the same idea without OpenZeppelin |
| Publish once | [`PublishOnce`](../examples/minimal/contracts/PublishOnce.compact) | no | k = 14, 14,065 rows | payload must be **constant** (anyone may make the one call); keep the flag in your own ledger field — do not reuse OpenZeppelin `Initializable` (shared module state) |
| Create and destroy | [`CreateAndDestroy`](../examples/minimal/contracts/CreateAndDestroy.compact) | no (only through a maintenance update) | k = 14, 14,041 rows | unguarded with a **constant** payload; the deployer calls it, then removes its verifier key (`VerifierKeyRemove` in the `v4` slot for ZKIR-v3 circuits — midnight-js 5.0.0-rc.2 removes only `v3`, question Q23). Until then anyone holding the compiled artefacts can call it, but can only re-emit the same values |

Whatever the circuit's guard, the contract's **maintenance authority** can insert or remove circuits at any time, so it
can change the metadata as well ([upgrade guide, Limits](upgrade-guide.md#limits)). Keep that key as carefully as the
owner key; `mip0018 deploy` stores it in the signer's 0600 private-state file.

## 4. Deploy and publish with `mip0018`

`mip0018` ([`packages/cli`](../packages/cli/README.md)) wraps midnight-js `deployContract` and `callTx` with a public
**run record** per contract (every transaction is written before submission), a **before-check** that skips a step the
chain already shows done, and an **after-check** that marks a step completed only when the indexer shows the expected
events (questions Q13, Q27). Re-running a command resumes; it never deploys or publishes twice.

Signing commands run in `docker/signer.sh`, the only container that mounts a wallet secret (read-only, from a 0700
directory outside the repository). Two official proof servers are needed today: `proof-server` 9.0.0-rc.8 for the
contract circuits (ZKIR v3) and 9.0.0-rc.6 for the wallet's DUST spends (question Q21).

**Local chain first** (official images, no funds needed) — the shell set-up of
[`examples/publish-and-emit`](../examples/publish-and-emit/README.md#1-local-chain-and-shell-set-up):

```sh
docker/local-stack/up.sh                       # official midnightntwrk images; random loopback ports ≥ 10000
. docker/local-stack/ports.env                 # MIP0018_STACK_NETWORK, the in-network URLs
WALK="$HOME/mip0018-walkthrough"; mkdir -p "$WALK/records" && mkdir -m 700 -p "$WALK/secrets" "$WALK/state"
NETENV="-e MIP0018_INDEXER_URL=$MIP0018_INDEXER_URL_IN_NETWORK -e MIP0018_NODE_URL=$MIP0018_NODE_URL_IN_NETWORK -v $WALK/records:/walk"

# signing commands: the only container that sees a wallet secret (none here: the local dev wallet is public)
signer() {
  MIP0018_DOCKER_NETWORK="$MIP0018_STACK_NETWORK" MIP0018_SECRET_DIR="$WALK/secrets" MIP0018_STATE_DIR="$WALK/state" \
  MIP0018_DOCKER_ENV="$NETENV -e MIP0018_PROOF_SERVER_URL=$MIP0018_PROOF_SERVER_URL_IN_NETWORK -e MIP0018_WALLET_PROOF_SERVER_URL=$MIP0018_WALLET_PROOF_SERVER_URL_IN_NETWORK" \
  docker/signer.sh mip0018 -- "$@"
}
# wallet-free commands
mip0018() { MIP0018_DOCKER_NETWORK="$MIP0018_STACK_NETWORK" MIP0018_DOCKER_ENV="$NETENV" docker/run.sh mip0018 -- "$@"; }
A="--network undeployed --dev-genesis-wallet --wallet-cache /run/mip0018/state/a.wallet-cache"

signer deploy-and-publish $A --example fungible-token --record /walk/fungible-token.json
mip0018 verify --network undeployed --record /walk/fungible-token.json --step publish
```

`deploy-and-publish` compiles (when `managed/` has no keys), deploys, calls `publishMetadata()` and verifies the event
wallet-free against the exact payload the example expects. Stop the chain with `docker/local-stack/down.sh`.

**Your own contract.** `--example <name>` loads `examples/<name>/mip0018.adapter.ts`; for your contract either:

- `--contract <managed dir>` — enough when the contract has no witnesses and no constructor arguments; or
- `--adapter <file>` — a module exporting `adapter`: the compiled contract (`managedDir`), its witnesses, the private
  state to create at deployment (e.g. an owner secret, stored only in the signer's 0600 private-state file), and the
  constructor arguments. Templates: [`examples/minimal/src/adapter.ts`](../examples/minimal/src/adapter.ts) (owner
  key), [`examples/openzeppelin/src/adapter.ts`](../examples/openzeppelin/src/adapter.ts) (OpenZeppelin `Ownable`);
  the interface is in [`packages/midnight/src/signer/adapter.ts`](../packages/midnight/src/signer/adapter.ts).

Then deploy and publish as two steps — on Stagenet, as case [C06](../deployments/stagenet/cases/C06/README.md) did
(`signer` here is the Stagenet variant below):

```sh
signer deploy --network stagenet --mnemonic-file /run/mip0018/secrets/stagenet-wallet.mnemonic --wallet-cache /run/mip0018/state/wallet1.cache --adapter examples/minimal/owner-key.mip0018.adapter.ts --record deployments/stagenet/cases/C06/record.json
signer publish --network stagenet --mnemonic-file /run/mip0018/secrets/stagenet-wallet.mnemonic --wallet-cache /run/mip0018/state/wallet1.cache --record deployments/stagenet/cases/C06/record.json --circuit publishMetadata --step publish
```

**Stagenet** needs a funded wallet registered for DUST (`mip0018 wallet status`, `wallet register-dust`), a mnemonic
file and the two proof servers on a Docker network you run
([`examples/publish-and-emit` §8](../examples/publish-and-emit/README.md#8-stagenet)):

```sh
signer() {
  MIP0018_SECRET_DIR="<0700 directory with the mnemonic file>" MIP0018_STATE_DIR="<0700 state directory outside the repo>" \
  MIP0018_DOCKER_NETWORK="<network of your two proof servers>" \
  MIP0018_DOCKER_ENV="-e MIP0018_PROOF_SERVER_URL=<proof-server 9.0.0-rc.8> -e MIP0018_WALLET_PROOF_SERVER_URL=<proof-server 9.0.0-rc.6>" \
  docker/signer.sh mip0018 -- "$@"
}
W="--network stagenet --mnemonic-file /run/mip0018/secrets/<wallet>.mnemonic --wallet-cache /run/mip0018/state/wallet.cache"
signer deploy $W --example fungible-token --record deployments/stagenet/cases/C01/record.json
signer publish $W --record deployments/stagenet/cases/C01/record.json --circuit publishMetadata --step publish
```

**Check what consumers see**, wallet-free (any network; Stagenet uses the public endpoints by default):

```sh
docker/run.sh mip0018 -- verify --network stagenet --record deployments/stagenet/cases/C01/record.json --step publish \
  --expect @deployments/stagenet/cases/C01/expect/publish.json
docker/run.sh mip0018 -- list --network stagenet --record deployments/stagenet/cases/C04/record.json --expect @deployments/stagenet/cases/C04/expected.json
```

`verify` checks the one emission end to end (event name, binding to your contract, decode result, raw transaction,
block, finality, the expected payload); `list` shows the state every consumer should reach. The run record
(`--record`) is public JSON: contract address, verifier-key hashes, transactions and observations — never a secret.

## 5. Rename and withdraw

Call the owner-only circuits with `publish`. Arguments are converted with the compiler's types; `{"$utf8": "…"}` must be
exactly the circuit's `Bytes<N>` length — a shorter text is refused rather than zero-padded (add `"pad": true` only
when you really want zero padding, e.g. a `pad(32, "…")` domain separator). From case C06 on Stagenet:

```sh
signer publish --network stagenet --mnemonic-file /run/mip0018/secrets/stagenet-wallet.mnemonic --wallet-cache /run/mip0018/state/wallet1.cache --record deployments/stagenet/cases/C06/record.json --circuit setMetadata --args '[{"$utf8":"Acme Prime"},{"$utf8":"ACMP"}]' --step rename
signer publish --network stagenet --mnemonic-file /run/mip0018/secrets/stagenet-wallet.mnemonic --wallet-cache /run/mip0018/state/wallet1.cache --record deployments/stagenet/cases/C06/record.json --circuit withdrawMetadata --step withdraw
signer publish --network stagenet --mnemonic-file /run/mip0018/secrets/stagenet-wallet.mnemonic --wallet-cache /run/mip0018/state/wallet1.cache --record deployments/stagenet/cases/C06/record.json --circuit setMetadata --args '[{"$utf8":"Acme Again"},{"$utf8":"ACMA"}]' --step revive
```

What consumers then show ([C06](../deployments/stagenet/cases/C06/README.md), every intermediate state re-checked):
after the rename "Acme Prime"/"ACMP" (the old name only as marked history); after the withdrawal nothing; after the
revive **only** `name` and `symbol` — `decimals` and `standards` cleared by the tombstone do not come back, so republish
every field you want shown.

A publish that would change nothing (the same values again, a second tombstone) is skipped by the before-check; pass
`--force` to emit it anyway. A non-owner's call is refused before anything is submitted
([C09](../deployments/stagenet/cases/C09/README.md)).

**Create and destroy** with the CLI (local chain, [`examples/publish-and-emit` §7](../examples/publish-and-emit/README.md#7-create-and-destroy)):

```sh
signer deploy-and-publish $A --example minimal --record /walk/minimal.json
signer remove-circuit $A --record /walk/minimal.json --circuit publishMetadata
signer publish $A --record /walk/minimal.json --circuit publishMetadata --step publish-again --force   # exit 1
```

The last command is refused (`publishMetadata has no verifier key`): the circuit no longer exists. On Stagenet:
[C10](../deployments/stagenet/cases/C10/README.md).

## 6. Costs

From the Stagenet receipts ([`docs/costs.md`](costs.md#fees-on-stagenet)):

- **A metadata transaction costs ≈ 0.17–0.19 DUST**, whatever the circuit size (publish, rename and tombstone alike).
- **The deploy dominates**: it stores every circuit's verifier key — about 0.6–0.9 DUST per extra circuit; the
  OpenZeppelin examples with three metadata circuits cost 6.1–7.0 DUST to deploy.
- **Circuit size costs proving time, not fees**: a fully constant payload compiles to k = 6 (the bare `emit`); any
  runtime byte, even a `domainSep` read from the ledger, gives k = 14; four runtime fields k = 15 (typed) — about
  2–4 s per proof on a 16-CPU host.
- `VerifierKeyRemove` (create-and-destroy) ≈ 0.04 DUST; `VerifierKeyInsert` (upgrade) ≈ 0.9 DUST on Stagenet.

## 7. Existing contracts

A token deployed without an emitting circuit does not need a redeployment if it has a usable maintenance authority
(the MIP's own note since `78ecbb4`: "a valid maintenance authority is required"):
compile an upgrade-only `publishMetadata()` against its exact ledger layout, insert its verifier key with
`VerifierKeyInsert`, call it — address, `domainSep` and color stay the same. See the
[upgrade guide](upgrade-guide.md) (`mip0018 upgrade`) and Stagenet case [U1](../deployments/stagenet/cases/U1/README.md).

## 8. Stagenet cases to look at

| Case | Shows |
|---|---|
| [C01](../deployments/stagenet/cases/C01/README.md) | OpenZeppelin `FungibleToken` (kind 3): deploy, publish three fields |
| [C02](../deployments/stagenet/cases/C02/README.md), [C03](../deployments/stagenet/cases/C03/README.md) | native shielded / unshielded: the minted coin's color = the identity's color |
| [C04](../deployments/stagenet/cases/C04/README.md) | one asset as kinds 1, 2, 3 from one publish: one symbol group |
| [C05](../deployments/stagenet/cases/C05/README.md) | token family: three `domainSep`, three identities |
| [C06](../deployments/stagenet/cases/C06/README.md) | lifecycle: publish (Appendix A bytes), rename, tombstone twice, revive |
| [C09](../deployments/stagenet/cases/C09/README.md) | a non-owner's rename refused |
| [C10](../deployments/stagenet/cases/C10/README.md) | create and destroy |
| [U1](../deployments/stagenet/cases/U1/README.md) | adding `publishMetadata()` to a deployed token |

Re-check any of them without a wallet: `docker/run.sh mip0018 -- recheck --network stagenet --case deployments/stagenet/cases/<ID>`
(all cases, addresses and fees: [`deployments/stagenet`](../deployments/stagenet/README.md)).

## Checklist

- [ ] One event per identity, published right after deployment; nothing emitted by mint, transfer or burn.
- [ ] Native tokens: `domainSep` read from the field the mint uses.
- [ ] `name`, `symbol`, `decimals` (`Uint<8>`) with exact byte lengths; `standards` only for what the token implements.
- [ ] Every emitting circuit owner-guarded, publish-once, or removed after use; the maintenance key kept safe.
- [ ] Runtime values validated off chain before the call.
- [ ] `mip0018 verify` and `list` show what you expect on the network you published to.
