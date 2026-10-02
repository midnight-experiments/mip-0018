// Fuzz: random 256-byte payloads never make the decoder throw or read out of bounds (every read goes through a
// bounds-checked accessor that throws BoundsInvariantError), every accepted payload is internally consistent,
// encode(decode(p)) == p for every accepted payload, and the payload with its trailing zero bytes dropped (as some
// sources return it) decodes exactly like p (MIP "Consuming": zero extension). Fixed seed + one random seed (logged;
// FUZZ_SEED reproduces it).
import { loadVectors } from '@mip0018/vectors/runner';
import { describe, expect, it } from 'vitest';
import {
  classifyEvent,
  decodePayload,
  encodePayload,
  EVENT_NAME,
  fromHex,
  toHex,
  type DecodeResult,
  type RejectReason,
} from '../src/index.ts';
import { structuredPayload } from './gen.ts';
import { makeRng, type Rng } from './prng.ts';

const COUNT = Number(process.env.FUZZ_COUNT ?? 100_000);
const FIXED_SEED = 0x4d495030; // "MIP0"
const RANDOM_SEED = process.env.FUZZ_SEED !== undefined ? Number(process.env.FUZZ_SEED) : crypto.getRandomValues(new Uint32Array(1))[0]!;

const REASONS = new Set<RejectReason>([
  'bad-payload-length',
  'bad-kind',
  'no-records',
  'nonzero-padding',
  'key-out-of-bounds',
  'valtype-out-of-bounds',
  'vallen-out-of-bounds',
  'value-out-of-bounds',
  'reserved-valtype',
  'invalid-utf8',
  'invalid-json',
  'invalid-uri',
  'bad-integer-length',
  'bad-null-length',
]);

const seeds = loadVectors()
  .filter((v) => v.entry.kind === 'payload')
  .map((v) => fromHex((v.data.event as { payload_hex: string }).payload_hex))
  .filter((p) => p.length === 256); // the informative zero-extension vectors are not 256 bytes

const NAME_TRIMMED = EVENT_NAME.subarray(0, 27);

/** The payload as a source that drops trailing zero bytes returns it. */
function trimZeros(p: Uint8Array): Uint8Array {
  let end = p.length;
  while (end > 0 && p[end - 1] === 0) end--;
  return p.subarray(0, end);
}

/** A comparable rendering of a decode result. */
function render(d: DecodeResult): string {
  if (!d.ok) return `reject ${d.reason} @${d.offset}`;
  const recs = d.records.map((r) => `${r.offset}:${toHex(r.key)}:${r.valType}:${toHex(r.value)}:${String(r.integer)}`);
  return `accept ${toHex(d.header.domainSep)} ${d.header.kind} ${d.contentEnd} ${recs.join(',')}`;
}

function mutated(r: Rng): Uint8Array {
  const p = r.pick(seeds).slice();
  const flips = 1 + r.int(4);
  for (let i = 0; i < flips; i++) p[r.chance(0.5) ? 32 + r.int(64) : r.int(256)] = r.chance(0.3) ? 0 : r.byte();
  return p;
}

interface Stats {
  accepted: number;
  rejected: Record<string, number>;
  maxMs: number;
}

function checkOne(p: Uint8Array, s: Stats): void {
  const t0 = performance.now();
  let d: ReturnType<typeof decodePayload>;
  try {
    d = decodePayload(p);
  } catch (e) {
    throw new Error(`decodePayload threw ${(e as Error).name}: ${(e as Error).message} on ${toHex(p)}`, {
      cause: e,
    });
  }
  s.maxMs = Math.max(s.maxMs, performance.now() - t0);
  const fail = (m: string): never => {
    throw new Error(`${m} — payload ${toHex(p)}`);
  };
  if (d.ok) {
    s.accepted++;
    if (d.header.kind < 1 || d.header.kind > 3) fail('accepted a bad kind');
    if (d.records.length < 1) fail('accepted without records');
    if (d.contentEnd > 256) fail('contentEnd past 256');
    let at = 33;
    for (const r of d.records) {
      if (r.offset !== at) fail('records not contiguous');
      if (r.key.length < 1) fail('empty key');
      at += 3 + r.key.length + r.value.length;
      if (at > 256) fail('record past 256');
    }
    if (at !== d.contentEnd) fail('contentEnd mismatch');
    for (let i = d.contentEnd; i < 256; i++) if (p[i] !== 0) fail('non-zero byte after content');
    if (toHex(encodePayload(d.header, d.records)) !== toHex(p)) fail('encode(decode(p)) != p');
  } else {
    if (!REASONS.has(d.reason)) fail(`unknown reason ${d.reason}`);
    if (d.offset < 0 || d.offset > 256) fail('offset out of range');
    s.rejected[d.reason] = (s.rejected[d.reason] ?? 0) + 1;
  }
  try {
    classifyEvent({ type: 'Misc', name: EVENT_NAME, payload: p });
    classifyEvent({ type: 'Misc', name: p.subarray(0, 32), payload: p });
  } catch (e) {
    fail(`classifyEvent threw ${(e as Error).message}`);
  }
  // Zero extension: the trimmed payload (and a trimmed name) give exactly the same decision and records.
  const t = trimZeros(p);
  if (render(decodePayload(t)) !== render(d)) fail(`decode of the ${t.length}-byte trimmed payload differs`);
  const full = classifyEvent({ type: 'Misc', name: EVENT_NAME, payload: p });
  const trimmed = classifyEvent({ type: 'Misc', name: NAME_TRIMMED, payload: t });
  if (full.result !== trimmed.result) fail('classifyEvent of the trimmed name and payload differs');
}

function campaign(seed: number): Stats {
  const r = makeRng(seed);
  const s: Stats = { accepted: 0, rejected: {}, maxMs: 0 };
  for (let i = 0; i < COUNT; i++) {
    const mode = i % 3;
    checkOne(mode === 0 ? r.bytes(256) : mode === 1 ? structuredPayload(r) : mutated(r), s);
  }
  return s;
}

describe('fuzz', () => {
  for (const [label, seed] of [
    ['fixed seed', FIXED_SEED],
    ['random seed', RANDOM_SEED],
  ] as const) {
    it(`${COUNT} payloads, ${label} 0x${seed.toString(16)}: no exception, no out-of-bounds read, round trip on accept`, () => {
      const s = campaign(seed);
      console.log(
        `fuzz ${label} seed=0x${seed.toString(16)} (FUZZ_SEED=${seed}) payloads=${COUNT} accepted=${s.accepted} rejected=${JSON.stringify(s.rejected)} maxDecodeMs=${s.maxMs.toFixed(2)}`,
      );
      expect(s.accepted).toBeGreaterThan(COUNT / 50); // the generators reach the accept path
      expect(Object.keys(s.rejected).length).toBeGreaterThanOrEqual(12); // and almost every reject path
      expect(s.maxMs).toBeLessThan(100);
    }, 120_000);
  }

  it('inputs longer than 256 bytes are rejected, shorter ones zero-extended — never thrown', () => {
    for (const n of [257, 288, 4096])
      expect(decodePayload(new Uint8Array(n))).toEqual({ ok: false, reason: 'bad-payload-length', offset: 0 });
    for (const n of [0, 1, 32, 33, 255]) expect(decodePayload(new Uint8Array(n))).toEqual({ ok: false, reason: 'bad-kind', offset: 32 });
    const a1 = seeds[0]!;
    expect(render(decodePayload(a1.subarray(0, 95)))).toBe(render(decodePayload(a1)));
    expect(decodePayload(Uint8Array.from([...a1, 0]))).toEqual({ ok: false, reason: 'bad-payload-length', offset: 0 });
  });

  it('decoding a view into a larger buffer reads only the view', () => {
    const big = new Uint8Array(1024).fill(0xee);
    const a1 = seeds[0]!;
    big.set(a1, 300);
    const d = decodePayload(big.subarray(300, 556));
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.contentEnd).toBe(95);
  });
});
