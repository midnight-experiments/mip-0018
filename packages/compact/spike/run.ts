// S2a spike runner (throw-away): execute each circuit in compact-runtime 0.20.0,
// capture the Misc event, compare with the S1 A1 fixture.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as rt from '@midnight-ntwrk/compact-runtime';

const here = import.meta.dirname;
const a1 = JSON.parse(readFileSync(join(here, '..', '..', '..', 'vectors', 'payload', 'A1.json'), 'utf8'));
const want = a1.event.name_hex + a1.event.payload_hex;
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

const CPK = '0'.repeat(64);
for (const c of ['SpikeTyped', 'SpikePure']) {
  const mod = await import(pathToFileURL(join(here, 'managed', c, 'contract', 'index.js')).href);
  const contract = new mod.Contract({});
  const init = await contract.initialState(rt.createConstructorContext({}, CPK));
  const address = rt.sampleContractAddress();
  for (const circuit of Object.keys(contract.circuits)) {
    const ctx = rt.createCircuitContext({
      circuitId: circuit,
      contractAddress: address,
      coinPublicKeyOrZswapState: CPK,
      contractState: init.currentContractState,
      privateState: {},
    });
    const args = circuit === 'a1Args'
      ? [new Uint8Array(32).fill(0x11), Buffer.from('Acme Token'), Buffer.from('ACME'), 6n, Buffer.from('mip-0004')]
      : [];
    const res = await contract.circuits[circuit](ctx, ...args);
    const evs = res.context.events;
    const misc = evs.filter((e: { eventType: string }) => e.eventType === 'misc');
    const ev = misc[0];
    const raw: Uint8Array = ev.data.content.value[0];
    const full = new Uint8Array(288);
    full.set(raw, 0);
    console.log(c, circuit, 'events', evs.length, 'misc', misc.length, 'rawLen', raw.length, 'equalsA1', hex(full) === want, 'addr ok', ev.address === address);
    if (hex(full) !== want) console.log(' got ', hex(full), '\n want', want);
  }
}
