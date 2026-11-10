# examples/minimal — the smallest MIP-0018 emitters (no OpenZeppelin)

Three ways to publish a token's metadata with [`packages/compact`](../../packages/compact), on a
deliberately tiny contract token ([`contracts/MinimalToken.compact`](contracts/MinimalToken.compact):
public balances, `mint`, `transfer` — not a token standard). All three publish MIP test **A1**
(Appendix A: `name` "Acme Token", `symbol` "ACME", `decimals` 6, `standards` "mip-0004", kind 3) for
the `domainSep` given at deployment.

| Contract | Who may publish | After publishing |
|---|---|---|
| [`CreateAndDestroy`](contracts/CreateAndDestroy.compact) | anyone (constant payload) | the maintenance authority **removes the circuit's verifier key**: it can never be called again |
| [`OwnerKey`](contracts/OwnerKey.compact) | the owner | the owner can rename (`setMetadata`) and withdraw (`withdrawMetadata`: one event with a Null record at each of the six common keys; with no field left the token is not referenced) |
| [`PublishOnce`](contracts/PublishOnce.compact) | anyone, once (constant payload) | a ledger flag refuses every later call |

## Add these 5 lines

```compact
import "../../../packages/compact/src/Mip0018" prefix Mip0018_;          // 1. the module

export circuit publishMetadata(): [] {                                  // 2. the circuit the MIP names
  Mip0018_emitPayload(Mip0018_commonFieldsWithStandards<10, 4, 8>(      // 3. sizes of the 3 strings
    domain, Mip0018_KIND_CONTRACT_TOKEN(), "Acme Token", "ACME", 6, "mip-0004")); // 4. your values
}                                                                       // 5.
```

`domain` is the token's `domainSep` (here a `sealed ledger` field set by the constructor; for a native
token it must be the value passed to `mintShieldedToken` / `mintUnshieldedToken`, so the color matches).
Then, at deployment:

1. **Deploy** the contract (a constructor cannot emit).
2. **Call `publishMetadata()`** right away; check the event (one `Misc` event, bound to the contract,
   payload = A1).
3. **Create and destroy only:** remove the circuit with a maintenance update signed by the contract's
   maintenance authority: `VerifierKeyRemove("publishMetadata", ContractOperationVersion("v4"))`
   (`v4` = the ZKIR-v3 key slot, the one midnight-js 5.0.0's `circuitMaintenanceTx.publishMetadata.removeVerifierKey()`
   removes as well).

Why the payload must be constant when the circuit is unguarded: until its key is removed (or, for
`PublishOnce`, until it ran), anyone with the compiled artefacts can call it. With constant values they
can only emit the same metadata again; with runtime parameters they could publish anything. The
deployed contract holds only the circuit's verifier key, not its ZKIR (observed), but DApps ship the
artefacts.

## Run it

```sh
# runtime tests (no chain): A1 bytes, no event from mint/transfer, owner checks, publish-once
docker/run.sh exec 'npx vitest run examples/minimal'

# create-and-destroy end to end on the local chain (official images; random 127.0.0.1 ports)
docker/local-stack/up.sh && . docker/local-stack/ports.env
docker/run.sh exec 'npm run -w examples/minimal compile -- --keys CreateAndDestroy'
MIP0018_DOCKER_NETWORK=$MIP0018_STACK_NETWORK docker/run.sh exec 'npm run -w examples/minimal create-and-destroy'
docker/local-stack/down.sh
```

[`scripts/create-and-destroy.ts`](scripts/create-and-destroy.ts) deploys `CreateAndDestroy`, calls
`publishMetadata()` (the indexer must return exactly one `Misc` event equal to A1), makes a holder
`transfer` (no `Misc` event), removes `publishMetadata`'s verifier key, and checks that a second call
is refused while `transfer` keeps its key. It signs with the local chain's public genesis dev wallet;
the run record goes to `docker/local-stack/.state/` (not committed).

Local run, 2026-11-10 (node 2.1.101, indexer 4.4.101, one proof server 9.0.1): deploy 1.472 DUST,
`publishMetadata` 0.165 DUST, `transfer` 0.272 DUST, `VerifierKeyRemove` 0.119 DUST; second call refused
(`Operation 'publishMetadata' is undefined`); exactly one `Misc` event, equal to A1. Circuit sizes and proving times:
[`docs/costs.md`](../../docs/costs.md).

On preview: `OwnerKey`'s publish → rename → withdraw → withdraw again → revive is case
[C06](../../deployments/preview/cases/C06/README.md) (the withdrawal is one event with a Null record at each of the six
common keys: the token is not listed until the revive, which brings back only `name` and `symbol`), and
`CreateAndDestroy` is case [C10](../../deployments/preview/cases/C10/README.md) (publish = A1, then
`VerifierKeyRemove`, a second publish refused). Both re-check wallet-free with
`docker/run.sh mip0018 -- recheck --network preview --case deployments/preview/cases/<ID>`.
