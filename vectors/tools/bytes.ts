// Small byte helpers shared by the vector tools (generator, runner, tests).
// Deliberately independent of packages/codec: the vectors are the oracle the codec is tested against.

export type Bytes = Uint8Array;

const encoder = new TextEncoder();
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function utf8(text: string): Bytes {
  return encoder.encode(text);
}

export function toHex(bytes: Bytes): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function fromHex(hex: string): Bytes {
  if (!/^([0-9a-fA-F]{2})*$/.test(hex)) throw new Error(`not an even-length hex string: ${hex.slice(0, 40)}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function cat(...parts: Array<Bytes | number[]>): Bytes {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function repeat(byte: number, count: number): Bytes {
  return new Uint8Array(count).fill(byte);
}

/** Bytes `start, start+1, …` modulo 256. */
export function sequence(count: number, start = 0): Bytes {
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) out[i] = (start + i) & 0xff;
  return out;
}

/** `pad(32, text)`: the ASCII text followed by zero bytes up to 32 bytes. */
export function pad32(text: string): Bytes {
  const t = utf8(text);
  if (t.length > 32) throw new Error(`name longer than 32 bytes: ${text}`);
  const out = new Uint8Array(32);
  out.set(t, 0);
  return out;
}

/** The bytes as text when they are valid UTF-8 without C0, DEL or C1 control characters (informative annotations only). */
export function printable(bytes: Bytes): string | undefined {
  let text: string;
  try {
    text = strictUtf8.decode(bytes);
  } catch {
    return undefined;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) return undefined;
  return text;
}

export function equalBytes(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
