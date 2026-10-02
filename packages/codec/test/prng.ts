// Small seeded PRNG (sfc32) for reproducible fuzzing. Not cryptographic.
export interface Rng {
  seed: number;
  u32(): number;
  /** Integer in [0, n). */
  int(n: number): number;
  byte(): number;
  chance(p: number): boolean;
  pick<T>(xs: readonly T[]): T;
  bytes(n: number): Uint8Array;
}

export function makeRng(seed: number): Rng {
  let a = 0x9e3779b9;
  let b = 0x243f6a88;
  let c = 0xb7e15162;
  let d = seed >>> 0;
  const u32 = (): number => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    const t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    const r = (t + d) | 0;
    c = (c + r) | 0;
    return r >>> 0;
  };
  for (let i = 0; i < 16; i++) u32();
  const rng: Rng = {
    seed,
    u32,
    int: (n) => Math.floor((u32() / 4294967296) * n),
    byte: () => u32() & 0xff,
    chance: (p) => u32() / 4294967296 < p,
    pick: (xs) => xs[Math.floor((u32() / 4294967296) * xs.length)] as never,
    bytes: (n) => {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = u32() & 0xff;
      return out;
    },
  };
  return rng;
}
