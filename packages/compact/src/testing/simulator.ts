// SPDX-License-Identifier: Apache-2.0
//
// A minimal compact-runtime 0.20.0 simulator for compiled contracts: deploy (run the constructor),
// call circuits against the current state, and capture the events each call emitted. No chain, no
// proofs. Every call gets a fresh CircuitContext, so `events` holds exactly that call's events.
//
// MIP-0018 view of an event (research compact-ledger §1.6): a Misc event's data is one Cell whose
// atom is the 288-byte `name ‖ payload` with trailing zero bytes trimmed; it is zero-extended to
// 288 bytes and split 32 / 256 here, exactly as the indexer does.

import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import * as rt from '@midnight-ntwrk/compact-runtime';

/** The size of a Misc event's data: name (32) + payload (256). */
export const MISC_DATA_SIZE = 288;

export type ObservedMisc = {
  /** Address of the contract that emitted the event (from the event record, never the payload). */
  readonly address: string;
  readonly name: Uint8Array;
  readonly payload: Uint8Array;
  /** Length of the atom as the runtime carried it (trailing zeros trimmed). */
  readonly rawLength: number;
};

export type CallOutcome<R = unknown> = {
  readonly result: R;
  /** Every log event of the call, in emission order. */
  readonly events: readonly rt.LogEvent[];
  /** The Misc events among them, decoded to name/payload. */
  readonly misc: readonly ObservedMisc[];
  /** The call's proof data (inputs, outputs, transcripts), e.g. for proving-time measurement. */
  readonly proofData: rt.CallProofData | undefined;
};

/** Zero-extends a trimmed Misc atom to 288 bytes and splits it into name and payload. */
export const splitMisc = (atom: Uint8Array): { name: Uint8Array; payload: Uint8Array } => {
  if (atom.length > MISC_DATA_SIZE) throw new Error(`Misc data is ${atom.length} bytes; at most ${MISC_DATA_SIZE} expected`);
  const full = new Uint8Array(MISC_DATA_SIZE);
  full.set(atom, 0);
  return { name: full.slice(0, 32), payload: full.slice(32) };
};

/** The Misc events of a call, decoded (other event types are skipped). */
export const miscEvents = (events: readonly rt.LogEvent[]): ObservedMisc[] =>
  events
    .filter((e) => e.eventType === 'misc')
    .map((e) => {
      if (e.data.tag !== 'cell') throw new Error(`Misc event data is a ${e.data.tag}, expected a cell`);
      const value = e.data.content.value;
      if (value.length !== 1) throw new Error(`Misc event cell has ${value.length} atoms, expected 1`);
      const atom = value[0]!;
      return { address: e.address, ...splitMisc(atom), rawLength: atom.length };
    });

type ContractModule = {
  Contract: new (witnesses: unknown) => {
    initialState(ctx: rt.ConstructorContext, ...args: unknown[]): Promise<rt.ConstructorResult>;
    circuits: Record<string, (ctx: rt.CircuitContext, ...args: unknown[]) => Promise<rt.CircuitResults>>;
  };
  pureCircuits: Record<string, (...args: unknown[]) => unknown>;
  ledger?: (state: rt.StateValue | rt.ChargedState) => unknown;
};

/** Loads managed/<Contract>/contract/index.js produced by `compact compile`. */
export const loadContractModule = async (managedDir: string): Promise<ContractModule> =>
  (await import(pathToFileURL(join(managedDir, 'contract', 'index.js')).href)) as ContractModule;

/** A zero coin public key: these contracts never send shielded coins to the caller. */
const COIN_PUBLIC_KEY = '0'.repeat(64);

export class Simulator<PS = unknown> {
  readonly address: string;
  readonly module: ContractModule;
  private readonly contract: InstanceType<ContractModule['Contract']>;
  private state: rt.ContractState | rt.ChargedState;
  private privateState: PS;

  private constructor(
    module: ContractModule,
    contract: InstanceType<ContractModule['Contract']>,
    initial: rt.ConstructorResult,
    address: string,
  ) {
    this.module = module;
    this.contract = contract;
    this.address = address;
    this.state = initial.currentContractState;
    this.privateState = initial.currentPrivateState as PS;
  }

  /** Runs the constructor with `args` and returns a simulator holding the initial state. */
  static async deploy<PS = unknown>(
    managedDir: string,
    o: { witnesses?: unknown; privateState?: PS; args?: readonly unknown[]; address?: string } = {},
  ): Promise<Simulator<PS>> {
    const module = await loadContractModule(managedDir);
    const contract = new module.Contract(o.witnesses ?? {});
    const initial = await contract.initialState(rt.createConstructorContext(o.privateState ?? {}, COIN_PUBLIC_KEY), ...(o.args ?? []));
    return new Simulator<PS>(module, contract, initial, o.address ?? rt.sampleContractAddress());
  }

  /** The current private state (witnesses may change it). */
  get currentPrivateState(): PS {
    return this.privateState;
  }

  /** Replaces the private state, e.g. to act as another caller. */
  set currentPrivateState(ps: PS) {
    this.privateState = ps;
  }

  /** The generated `ledger()` view of the current public state. */
  ledger<L = unknown>(): L {
    if (!this.module.ledger) throw new Error('the contract module exports no ledger()');
    const data = this.state instanceof rt.ContractState ? this.state.data : this.state;
    return this.module.ledger(data) as L;
  }

  /**
   * Calls a circuit against the current state. On success the new state is kept; when the circuit
   * fails (e.g. a failed assert), it throws and the state is unchanged — nothing was emitted.
   */
  async call<R = unknown>(circuit: string, ...args: unknown[]): Promise<CallOutcome<R>> {
    const fn = this.contract.circuits[circuit];
    if (!fn) throw new Error(`no circuit ${circuit}`);
    const ctx = rt.createCircuitContext({
      circuitId: circuit,
      contractAddress: this.address,
      coinPublicKeyOrZswapState: COIN_PUBLIC_KEY,
      contractState: this.state,
      privateState: this.privateState,
    });
    const res = await fn(ctx, ...args);
    this.state = res.context.callContext.currentQueryContext.state;
    this.privateState = res.context.callContext.currentPrivateState as PS;
    const events = res.context.events;
    return {
      result: res.result as R,
      events,
      misc: miscEvents(events),
      proofData: res.context.callProofDataTrace.at(-1),
    };
  }
}
