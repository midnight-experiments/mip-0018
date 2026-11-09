# Issuer guide — publish MIP-0018 metadata for your token

How a token contract publishes its name, symbol and decimals as MIP-0018 events
([MIP-0018 @ `338ea194`](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/338ea194bbe7c4e5d1829234a503b7c1b11ebf0f/mips/mip-0018-on-chain-token-metadata.md)):
what to emit, the Compact lines to add, who may call them, and how to deploy, publish, rename and withdraw with the
`mip0018` CLI. Everything shown was run on a local chain; the commands are copied from the walkthroughs
[`examples/publish-and-emit`](../examples/publish-and-emit/README.md) and
[`examples/verify`](../examples/verify/README.md). The reader side is the
[consumer guide](consumer-guide.md).

Toolchain: MIP-0018 needs MIP-0002 `Misc` events, so **Compact 0.34.0 or later**; this repository builds and tests with
**Compact 0.36.0** ([`toolchain.json`](../toolchain.json)), all inside the pinned Docker image.

## 1. What to publish

One event describes one **token identity** `(contractAddress, domainSep, kind)`:

| `kind` | Token | `domainSep` | Color |
|---:|---|---|---|
| 1 | shielded UTXO — a contract-issued UTXO token held as shielded coins | the value your contract passes to `mintShieldedToken` | `tokenType(domainSep, contractAddress)` |
| 2 | unshielded UTXO — a contract-issued UTXO token held as unshielded UTXOs | the value passed to `mintUnshieldedToken` | the same formula |
| 3 | contract token — represented by contract logic, e.g. balances in contract state | any stable 32 bytes you choose, e.g. `pad(32, "acme:gold")` | none |

The contract address is never in the payload: consumers take it from the event record, so a contract can only describe
its own tokens. For a contract-issued UTXO token the `domainSep` **must** be the minting value — read it from the same
ledger field the mint uses — or the color consumers derive will not be the color of your coins. One asset held in
several forms (shielded UTXO, unshielded UTXO, contract token) is several identities: publish one event per kind
([`examples/openzeppelin/multi-kind`](../examples/openzeppelin/multi-kind/README.md)).

What to put in the event:

- **`name`, `symbol`, `decimals`** (SHOULD) — `name` UTF-8 of 1–64 characters, `symbol` UTF-8 of 1–12 characters, and
  `decimals` as a `Uint<8>`. A character is a grapheme cluster (what a reader sees as one character), not a byte;
  consumers show only the first 64 / 12, so keep within the limits. Consumers assume no default: a token without
  `decimals` shows no amounts.
- **`standards`** (MAY) — standards the token claims, as `mip-NNNN` identifiers separated by single spaces. Claim only
  what the token implements: the OpenZeppelin examples publish none, because OpenZeppelin claims no MIP.
- **`image`, `image_sha256`** (MAY) — the token's image or logo as a URI (type 4: ASCII only, e.g.
  `https://example.org/acme.png`), and the SHA-256 of that file (type 0, exactly 32 bytes). Consumers do not display
  content whose SHA-256 differs from `image_sha256`, so publish the hash of the exact file you serve. Module:
  `imageRecord<N>(uri)` and `imageSha256Record(hash)`; codec: `record.image`, `record.imageSha256`.
- **Only keys a MIP defines are served.** Consumers serve the common keys above and the keys of standards the token
  declares in `standards`; any other key is accepted on chain but shown by no conforming consumer. Keys must be valid
  UTF-8.
- **Exact bytes.** Keys and values are compared byte for byte. The MIP says it outright (Payload):
  "Each fixed-size field must be exactly as long as the key or value it carries: a shorter value padded with zero
  bytes is a different value (for example `"AGL"` sent as a `Bytes<4>` is `"AGL\0"`), and consumers accept it as such."
  Every size in the module is the value's UTF-8 byte length.
- **One event per identity.** The payload is 256 bytes: a 33-byte header, then records of `3 + key + value` bytes; the
  largest value is 219 bytes. The three common fields plus `standards` take 62 bytes (MIP Appendix A); `image` and
  `image_sha256` take `8 + URI length` and 47 more.
- **Getters.** If the token also exposes standard getters (for example MIP-0004/0011/0014 `name()` / `symbol()` /
  `decimals()`), publish the same values when you first publish. Nothing on chain checks this; the OpenZeppelin
  examples take both from one `metadata.json` and read `decimals` from the token state. "A later update, such as a
  rename, is the token's current metadata for consumers of this MIP even where the getters cannot change" (MIP Common
  fields) — OpenZeppelin's `sealed` getters keep their values after a rename. A MIP that
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
    domain, Mip0018_KIND_CONTRACT_TOKEN(), "Acme Token", "ACME", 6, "mip-0004"));
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
    Mip0018_header(metadataDomain(), Mip0018_KIND_CONTRACT_TOKEN()),
    Mip0018_nameRecord<9>(newName),
    Mip0018_symbolRecord<4>(newSymbol)));
}

export circuit withdrawMetadata(): [] {
  Ownable_assertOnlyOwner();
  Mip0018_emitPayload(Mip0018_withdraw(metadataDomain(), Mip0018_KIND_CONTRACT_TOKEN()));
}
```

A rename changes only the keys it carries. **Deleting** is per key (MIP "Applying records"): a Null
record deletes its own field, and "a token identity exists only while at least one of its fields has a value".

- **Withdraw a token**: emit a Null record for each of its keys; one event can carry them all. `withdraw(domainSep,
  kind)` is that event for the six common keys — Null records at `name`, `symbol`, `decimals`, `standards`, `image` and
  `image_sha256` (62 bytes of records; a Null record for a key without a value changes nothing). Once every key is
  deleted, consumers do not reference the identity at all (not listed, not found by a lookup, in no group, no
  history); the next publish describes it again with only what it carries. **A token that published keys of a
  declared standard must add a Null record for each of them** — otherwise those keys keep the identity alive. Build
  that event with `nullRecord<K>(key)` and `payload<n>`, e.g.
  `Mip0018_payload1<4, 0>(Mip0018_header(domainSep, kind), Mip0018_nullRecord<4>("logo"))` for a 4-byte key `logo`
  (or put up to six Null records in one `payload6`).
- **Delete a single key**: one Null record for it, e.g.
  `Mip0018_emitPayload(Mip0018_payload1<4, 0>(Mip0018_header(domainSep, kind), Mip0018_nullRecord<4>("name")))`; the
  other fields stay. A Null record for a key that has no value changes nothing.

**Two constructions, same bytes.** The default module `Mip0018` builds typed records that Compact
serializes, so the compiler checks every size. The alternative `Mip0018Pure` composes the payload from individual
pure circuits with `Bytes[...]` spreads; it exists because it does not rely on `serialize` for non-event types. Both
emit identical bytes, equal to the vectors; the typed one is 1.3–1.5× smaller for runtime values (four runtime fields:
k = 16 vs 17), so use it unless you have a reason not to.

**What the compiler cannot check**: that a runtime UTF-8 value is valid UTF-8, a JSON value valid JSON, or a URI an
RFC 3986 `URI` (scheme required, ASCII only). String literals are fine; validate runtime arguments off
chain before the call, e.g. with `@mip0018/codec`'s `encodePayload`, which throws on anything a consumer would reject.
A malformed event is rejected whole by every consumer.

Compile with keys (a deploy needs the verifier keys); for a contract of your own, in the pinned image:

```sh
docker/run.sh exec 'compact compile --compact-path node_modules examples/openzeppelin/fungible-token/contracts/MyFungibleToken.compact managed/MyFungibleToken'
```

(source path and output directory are yours; `managed/` output is never committed — builds are deterministic, and
the verifier-key SHA-256s are in [`docs/costs.json`](costs.json) and [`examples/openzeppelin/costs.json`](../examples/openzeppelin/costs.json)). The examples have their own scripts,
e.g. `docker/run.sh exec 'npm run -s compile -w examples/openzeppelin -- --keys --with-metadata-only fungible-token'`.

## 3. Choose who may publish

Anyone who can call an emitting circuit can rename or withdraw the token, so the MIP says it "SHOULD be
access-controlled, publish-once, or removed after use" (Publishing). Four patterns, all tested; sizes from [`docs/costs.md`](costs.md):

| Pattern | Example | Rename / withdraw later | `publishMetadata()` size | Caveats |
|---|---|---|---|---|
| OpenZeppelin `Ownable` | [`examples/openzeppelin`](../examples/openzeppelin/README.md) | yes, owner-only | fungible k = 14 (literal `domainSep`), native-shielded / native-unshielded examples k = 16 | `Ownable_assertOnlyOwner()` first in every emitting circuit; the owner secret lives in the deployer's private state |
| Owner key (hand-rolled) | [`OwnerKey`](../examples/minimal/contracts/OwnerKey.compact) | yes, owner-only | k = 16, 38,363 rows | the same idea without OpenZeppelin |
| Publish once | [`PublishOnce`](../examples/minimal/contracts/PublishOnce.compact) | no | k = 16, 34,554 rows | payload must be **constant** (anyone may make the one call); keep the flag in your own ledger field — do not reuse OpenZeppelin `Initializable` (shared module state) |
| Create and destroy | [`CreateAndDestroy`](../examples/minimal/contracts/CreateAndDestroy.compact) | no (only through a maintenance update) | k = 16, 34,530 rows | unguarded with a **constant** payload; the deployer calls it, then removes its verifier key (`VerifierKeyRemove` in the `v4` slot, where ZKIR-v3 keys live; midnight-js 5.0.0's `removeVerifierKey()` uses it too). Until then anyone holding the compiled artefacts can call it, but can only re-emit the same values |

Whatever the circuit's guard, the contract's **maintenance authority** can insert or remove circuits at any time, so it
can change the metadata as well ([upgrade guide, Limits](upgrade-guide.md#limits)). Keep that key as carefully as the
owner key; `mip0018 deploy` stores it in the signer's 0600 private-state file.

## 4. Deploy and publish with `mip0018`

`mip0018` ([`packages/cli`](../packages/cli/README.md)) wraps midnight-js `deployContract` and `callTx` with a public
**run record** per contract (every transaction is written before submission), a **before-check** that skips a step the
chain already shows done, and an **after-check** that marks a step completed only when the indexer shows the expected
events. Re-running a command resumes; it never deploys or publishes twice.

Signing commands run in `docker/signer.sh`, the only container that mounts a wallet secret (read-only, from a 0700
directory outside the repository). One official proof server (`midnightntwrk/proof-server` 9.0.1) proves both the
contract circuits and the wallet's DUST spends.

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
  MIP0018_DOCKER_ENV="$NETENV -e MIP0018_PROOF_SERVER_URL=$MIP0018_PROOF_SERVER_URL_IN_NETWORK" \
  docker/signer.sh mip0018 -- "$@"
}
# wallet-free commands
mip0018() { MIP0018_DOCKER_NETWORK="$MIP0018_STACK_NETWORK" MIP0018_DOCKER_ENV="$NETENV" docker/run.sh mip0018 -- "$@"; }
A="--network undeployed --dev-genesis-wallet --wallet-cache /run/mip0018/state/a.wallet-cache"

signer deploy-and-publish $A --example fungible-token --record /walk/fungible-token.json
mip0018 check-event --network undeployed --record /walk/fungible-token.json --step publish
```

`deploy-and-publish` compiles (when `managed/` has no keys), deploys, calls `publishMetadata()` and checks the event
wallet-free against the exact payload the example expects. Stop the chain with `docker/local-stack/down.sh`.

**Your own contract.** `--example <name>` loads `examples/<name>/mip0018.adapter.ts`; for your contract either:

- `--contract <managed dir>` — enough when the contract has no witnesses and no constructor arguments; or
- `--adapter <file>` — a module exporting `adapter`: the compiled contract (`managedDir`), its witnesses, the private
  state to create at deployment (e.g. an owner secret, stored only in the signer's 0600 private-state file), and the
  constructor arguments. Templates: [`examples/minimal/src/adapter.ts`](../examples/minimal/src/adapter.ts) (owner
  key), [`examples/openzeppelin/src/adapter.ts`](../examples/openzeppelin/src/adapter.ts) (OpenZeppelin `Ownable`);
  the interface is in [`packages/midnight/src/signer/adapter.ts`](../packages/midnight/src/signer/adapter.ts).

Then deploy and publish as two steps. On a public network — `preview`, or `preprod` / `mainnet` with the Blockfrost
project token of that network in `MIP0018_BLOCKFROST_PREPROD` / `MIP0018_BLOCKFROST_MAINNET` (or a 0600 file,
`--blockfrost-token-file`; passed to the containers by name, never written anywhere) — the signer needs a funded wallet
registered for DUST (`mip0018 wallet status`, `wallet register-dust`), a mnemonic file and a proof server on a Docker
network you run ([`examples/publish-and-emit` §8](../examples/publish-and-emit/README.md#8-public-networks)):

```sh
signer() {
  MIP0018_SECRET_DIR="<0700 directory with the mnemonic file>" MIP0018_STATE_DIR="<0700 state directory outside the repo>" \
  MIP0018_DOCKER_NETWORK="<Docker network of your proof server>" \
  MIP0018_DOCKER_ENV="-e MIP0018_PROOF_SERVER_URL=<proof-server 9.0.1 URL on that network>" \
  docker/signer.sh mip0018 -- "$@"
}
W="--network preview --mnemonic-file /run/mip0018/secrets/<wallet>.mnemonic --wallet-cache /run/mip0018/state/wallet.cache"
signer deploy $W --adapter examples/minimal/owner-key.mip0018.adapter.ts --record /run/mip0018/state/owner-key.json
signer publish $W --record /run/mip0018/state/owner-key.json --circuit publishMetadata --step publish
```

**Check what consumers see**, wallet-free (any network; the public profiles carry their endpoints):

```sh
docker/run.sh mip0018 -- check-event --network preview --record <record file> --step publish --expect @<expectation file>
docker/run.sh mip0018 -- list --network preview --record <record file> --expect @<metadata.json or expected state>
```

`check-event` checks the one emission end to end (event name, binding to your contract, decode result and every
record, raw transaction, block, finality, the expected payload); `list` shows the state every consumer should reach. The run record
(`--record`) is public JSON: contract address, verifier-key hashes, transactions and observations — never a secret.

## 5. Rename and withdraw

Call the owner-only circuits with `publish`. Arguments are converted with the compiler's types; `{"$utf8": "…"}` must be
exactly the circuit's `Bytes<N>` length — a shorter text is refused rather than zero-padded (add `"pad": true` only
when you really want zero padding, e.g. a `pad(32, "…")` domain separator). With the owner-key contract above:

```sh
signer publish $W --record /run/mip0018/state/owner-key.json --circuit setMetadata --args '[{"$utf8":"Acme Prime"},{"$utf8":"ACMP"}]' --step rename
signer publish $W --record /run/mip0018/state/owner-key.json --circuit withdrawMetadata --step withdraw
signer publish $W --record /run/mip0018/state/owner-key.json --circuit setMetadata --args '[{"$utf8":"Acme Again"},{"$utf8":"ACMA"}]' --step revive
```

What consumers then show: after the rename "Acme Prime"/"ACMP" (the replaced name only as marked history).
`OwnerKey`'s `withdrawMetadata` emits Null records at the four keys the token has (`name`, `symbol`, `decimals`,
`standards`): after it the token is not listed at all and has no group; after the revive it has **only** `name` and
`symbol` — `decimals` and `standards` do not come back, so republish every field you want shown.

A publish that would change nothing (the same values again, a second withdrawal) is skipped by the before-check; pass
`--force` to emit it anyway. A non-owner's call is refused before anything is submitted.

**Create and destroy** with the CLI (local chain, [`examples/publish-and-emit` §7](../examples/publish-and-emit/README.md#7-create-and-destroy)):

```sh
signer deploy-and-publish $A --example minimal --record /walk/minimal.json
signer remove-circuit $A --record /walk/minimal.json --circuit publishMetadata
signer publish $A --record /walk/minimal.json --circuit publishMetadata --step publish-again --force   # exit 1
```

The last command is refused (`publishMetadata has no verifier key`): the circuit cannot be called.

## 6. Costs

From the local-stack receipts ([`docs/costs.md`](costs.md#fees-on-the-local-stack)):

- **A metadata transaction costs ≈ 0.15–0.20 DUST**, whatever the circuit size (publish, rename and withdraw alike).
- **The deploy dominates**: it stores every circuit's verifier key — 1.1 DUST for one circuit (`LegacyToken`); the
  OpenZeppelin examples with three metadata circuits (eight to ten circuits in all) cost 4.7–5.3 DUST to deploy.
- **Circuit size costs proving time, not fees**: a fully constant payload compiles to k = 6 (the bare `emit`); any
  runtime byte, even a `domainSep` read from the ledger, gives k = 15–16; four runtime fields k = 16 (typed) — about
  1.5–4 s per proof on a 12-CPU host.
- `VerifierKeyRemove` (create-and-destroy) ≈ 0.11–0.13 DUST; `VerifierKeyInsert` (upgrade) ≈ 0.70 DUST.

## 7. Existing contracts

A token deployed without an emitting circuit does not need a redeployment if it has a usable maintenance authority
(the MIP notes that "a valid maintenance authority is required"):
compile an upgrade-only `publishMetadata()` against its exact ledger layout, insert its verifier key with
`VerifierKeyInsert`, call it — address, `domainSep` and color stay the same. See the
[upgrade guide](upgrade-guide.md) (`mip0018 upgrade`).

## Checklist

- [ ] One event per identity, published right after deployment; nothing emitted by mint, transfer or burn.
- [ ] Contract-issued UTXO tokens (kinds 1, 2): `domainSep` read from the field the mint uses.
- [ ] `name` (≤ 64 characters), `symbol` (≤ 12), `decimals` (`Uint<8>`) with exact byte lengths; `standards` only for
  what the token implements; `image_sha256` = the SHA-256 of the file at `image`.
- [ ] Every emitting circuit owner-guarded, publish-once, or removed after use; the maintenance key kept safe.
- [ ] Runtime values validated off chain before the call.
- [ ] `mip0018 check-event` and `list` show what you expect on the network you published to.
