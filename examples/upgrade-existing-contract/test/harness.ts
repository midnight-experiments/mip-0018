// SPDX-License-Identifier: Apache-2.0
//
// Runs compiled contracts in compact-runtime 0.20.0 against ONE shared contract state, as the chain does after a
// VerifierKeyInsert: the legacy contract's constructor and circuits create and change the state; a circuit of the
// upgrade-only source then runs against that same state and address. No chain, no proofs.
import * as rt from '@midnight-ntwrk/compact-runtime';
import { loadContractModule, miscEvents, type ObservedMisc } from '@mip0018/compact/testing';

type Module = Awaited<ReturnType<typeof loadContractModule>>;
type Instance = InstanceType<Module['Contract']>;

/** A coin public key for the simulated caller (the recipient of shielded mints). */
export const CALLER_COIN_PUBLIC_KEY = 'ab'.repeat(32);

export class SharedState<PS> {
  readonly address: string;
  /** The contract state as the chain would hold it (data + the deploy-time operations, which are not used here). */
  state: rt.ContractState;
  privateState: PS;

  private constructor(address: string, state: rt.ContractState, privateState: PS) {
    this.address = address;
    this.state = state;
    this.privateState = privateState;
  }

  /** Runs the constructor of `managedDir`'s contract. */
  static async deploy<PS>(managedDir: string, witnesses: unknown, privateState: PS, args: unknown[]): Promise<SharedState<PS>> {
    const m = await loadContractModule(managedDir);
    const c = new m.Contract(witnesses);
    const init = await c.initialState(rt.createConstructorContext(privateState, CALLER_COIN_PUBLIC_KEY), ...args);
    return new SharedState(rt.sampleContractAddress(), init.currentContractState, init.currentPrivateState as PS);
  }

  /** The serialized contract state (what the indexer returns as `contractAction.state`), hex. */
  stateHex(): string {
    return Buffer.from(this.state.serialize()).toString('hex');
  }

  /** Calls `circuit` of the contract compiled in `managedDir` against the shared state (as this address). */
  async call<R = unknown>(
    managedDir: string,
    witnesses: unknown,
    circuit: string,
    ...args: unknown[]
  ): Promise<{ result: R; misc: ObservedMisc[]; events: readonly rt.LogEvent[] }> {
    const m = await loadContractModule(managedDir);
    const c: Instance = new m.Contract(witnesses);
    const fn = c.circuits[circuit];
    if (!fn) throw new Error(`${managedDir} has no circuit ${circuit}`);
    const ctx = rt.createCircuitContext({
      circuitId: circuit,
      contractAddress: this.address,
      coinPublicKeyOrZswapState: CALLER_COIN_PUBLIC_KEY,
      contractState: this.state,
      privateState: this.privateState,
    });
    const res = await fn(ctx, ...args);
    // Keep the deploy-time ContractState object (operations, authority) and replace its data, as a transaction does.
    const next = rt.ContractState.deserialize(this.state.serialize());
    next.data = res.context.callContext.currentQueryContext.state as rt.ChargedState;
    this.state = next;
    this.privateState = res.context.callContext.currentPrivateState as PS;
    return { result: res.result as R, misc: miscEvents(res.context.events), events: res.context.events };
  }

  /** The generated `ledger()` view of the shared state through `managedDir`'s accessor. */
  async ledger<L = Record<string, unknown>>(managedDir: string): Promise<L> {
    const m = await loadContractModule(managedDir);
    if (!m.ledger) throw new Error(`${managedDir} exports no ledger()`);
    return m.ledger(this.state.data) as L;
  }
}
