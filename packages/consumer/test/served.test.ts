// Served keys (MIP "Keys"), name/symbol length (MIP "Common fields", Testing S11) and the image check (S12), beyond
// the vectors: every accepted record is stored, but only the common keys and the keys of standards the token
// currently declares are served; the served keys follow `standards` whenever it changes; an identity with no served
// field is not referenced; a long `name`/`symbol` is served as its first 64 / 12 characters (grapheme clusters) while grouping
// compares the stored bytes; content from `image` is refused when a set `image_sha256` differs.
import { createHash } from 'node:crypto';
import { encodePayload, EVENT_NAME, record, type MetadataRecord } from '@mip0018/codec';
import { describe, expect, it } from 'vitest';
import { characters, imageContentAllowed, MetadataState, servedValue, truncateCharacters, type ObservedEvent } from '../src/index.ts';

const D = new Uint8Array(32).fill(0x11);
const D2 = new Uint8Array(32).fill(0x22);
const A = 'aa'.repeat(32);
const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex');
const NAME = hex('name');
const SYMBOL = hex('symbol');
const FOO = hex('foo');
const K = hex('k');
const IMAGE_SHA256 = hex('image_sha256');
const DEFINED = { 'test-s10': [{ key: 'k', valType: 1 }] };

let block = 0;
const ev = (kind: number, records: MetadataRecord[], o: Partial<ObservedEvent> & { domainSep?: Uint8Array } = {}): ObservedEvent => ({
  network: 'n',
  contractAddress: A,
  block: ++block,
  tx: 0,
  event: 0,
  type: 'Misc',
  name: EVENT_NAME,
  payload: encodePayload({ domainSep: o.domainSep ?? D, kind }, records),
  ...o,
});
const keys = (s: MetadataState, kind = 3, d = D) =>
  s
    .identity('n', A, d, kind)
    ?.fields.map((f) => f.keyHex)
    .sort();

describe('served keys (MIP "Keys")', () => {
  it('a key that is neither common nor defined by a declared standard is stored but not served (S10: foo = "x")', () => {
    const s = new MetadataState({ keepHistory: true });
    expect(s.apply(ev(3, [record.utf8('name', 'Acme'), record.utf8('foo', 'x')])).result).toBe('accept');
    expect(keys(s)).toEqual([NAME]);
    s.apply(ev(3, [record.utf8('foo', 'y')]));
    expect(s.history(s.identities()[0]!.key, FOO)).toEqual([]);
    expect(s.identities()[0]!.fields.map((f) => f.keyHex)).toEqual([NAME]);
  });

  it('every common key is served: name, symbol, decimals, standards, image, image_sha256', () => {
    const s = new MetadataState();
    s.apply(
      ev(3, [
        record.utf8('name', 'Acme'),
        record.utf8('symbol', 'ACME'),
        record.uint('decimals', 6),
        record.utf8('standards', 'mip-0004'),
        record.image('https://example.org/acme.png'),
        record.imageSha256(new Uint8Array(32).fill(7)),
      ]),
    );
    expect(keys(s)).toEqual(['name', 'symbol', 'decimals', 'standards', 'image', 'image_sha256'].map(hex).sort());
    expect(s.identities()[0]!.common).toEqual({
      name: 'Acme',
      symbol: 'ACME',
      decimals: 6n,
      standards: ['mip-0004'],
      image: 'https://example.org/acme.png',
      imageSha256: '07'.repeat(32),
    });
  });

  it("a standard's key is served only while the token's current standards lists that standard, whenever its record arrived (S10)", () => {
    const s = new MetadataState({ definedKeys: DEFINED, keepHistory: true });
    s.apply(ev(3, [record.utf8('name', 'Acme'), record.utf8('k', 'v')])); // before the standard is declared
    expect(keys(s)).toEqual([NAME]);
    s.apply(ev(3, [record.utf8('standards', 'test-s10')])); // declared: k (sent earlier) is served
    expect(keys(s)).toEqual([K, NAME, hex('standards')].sort());
    const k = s.identities()[0]!.fields.find((f) => f.keyHex === K)!;
    expect([k.usable, Buffer.from(k.value).toString()]).toEqual([true, 'v']);
    s.apply(ev(3, [record.utf8('k', 'w')])); // set while declared
    expect(s.history(s.identities()[0]!.key, K).map((h) => Buffer.from(h.value).toString())).toEqual(['v']);
    s.apply(ev(3, [record.utf8('standards', '')])); // removed: not served
    expect(keys(s)).toEqual([NAME, hex('standards')].sort());
    expect(s.history(s.identities()[0]!.key, K)).toEqual([]);
    s.apply(ev(3, [record.utf8('standards', 'mip-0004 test-s10')])); // re-declared: served again, latest value
    expect(Buffer.from(s.identities()[0]!.fields.find((f) => f.keyHex === K)!.value).toString()).toBe('w');
    s.apply(ev(3, [record.utf8('standards', 'test-s10  mip-0004')])); // malformed standards: unusable, nothing declared
    expect(keys(s)).toEqual([NAME, hex('standards')].sort());
  });

  it('a Null record deletes a stored key even while it is not served; declaring its standard later serves nothing for it', () => {
    const s = new MetadataState({ definedKeys: DEFINED });
    s.apply(ev(3, [record.utf8('name', 'Acme'), record.utf8('k', 'v')]));
    s.apply(ev(3, [record.tombstone('k')]));
    s.apply(ev(3, [record.utf8('standards', 'test-s10')]));
    expect(keys(s)).toEqual([NAME, hex('standards')].sort());
  });

  it("a standard's key with another value type than its definition is served as unusable", () => {
    const s = new MetadataState({ definedKeys: DEFINED });
    s.apply(ev(3, [record.utf8('standards', 'test-s10'), record.bytes('k', Uint8Array.of(1))]));
    expect(s.identities()[0]!.fields.find((f) => f.keyHex === K)!.usable).toBe(false);
  });

  it('without definedKeys (the default) only the common keys are served, whatever standards says', () => {
    const s = new MetadataState();
    s.apply(ev(3, [record.utf8('standards', 'test-s10'), record.utf8('k', 'v')]));
    expect(keys(s)).toEqual([hex('standards')]);
  });
});

describe('identity existence with unserved keys', () => {
  it('an identity whose only fields are unserved keys is not referenced anywhere (listings, lookups, groups, history, display)', () => {
    const s = new MetadataState({ keepHistory: true });
    s.apply(ev(1, [record.utf8('foo', 'x')]));
    s.apply(ev(1, [record.utf8('foo', 'y'), record.utf8('SYMBOL', 'ACME')]));
    expect(s.identities()).toEqual([]);
    expect(s.identity('n', A, D, 1)).toBeUndefined();
    expect(s.groups()).toEqual([]);
    expect(s.history(`n|${A}|${'11'.repeat(32)}|1`, FOO)).toEqual([]);
    expect(s.display(s.identity('n', A, D, 1), 1n)).toEqual({ decimals: null, text: null });
  });

  it('it is referenced once a servable field has a value, with only the served fields', () => {
    const s = new MetadataState({ definedKeys: DEFINED });
    s.apply(ev(1, [record.utf8('foo', 'x'), record.utf8('k', 'v')]));
    expect(s.identities()).toEqual([]);
    s.apply(ev(1, [record.utf8('symbol', 'ACME')]));
    expect(keys(s, 1)).toEqual([SYMBOL]);
    expect(s.groups()).toHaveLength(1);
    s.apply(ev(1, [record.tombstone('symbol')])); // its last served field is deleted: unreferenced again
    expect(s.identities()).toEqual([]);
    expect(s.groups()).toEqual([]);
    s.apply(ev(1, [record.utf8('standards', 'test-s10')])); // declaring the standard serves k (and standards)
    expect(keys(s, 1)).toEqual([K, hex('standards')].sort());
  });
});

describe('name and symbol length (MIP "Common fields", S11)', () => {
  const nameOf = (s: MetadataState) => s.identities()[0]!.common.name;
  const symbolOf = (s: MetadataState) => s.identities()[0]!.common.symbol;
  const one = (records: MetadataRecord[]) => {
    const s = new MetadataState({ keepHistory: true });
    s.apply(ev(3, records));
    return s;
  };

  // Multi-code-point grapheme clusters with stable segmentation: combining marks, a flag, Hangul L+V+T jamo.
  const CLUSTERS = ['e\u0301', 'a', 'b', 'A\u030A', 'd', '\u{1F1FA}\u{1F1FE}', 'f', 'g', '\u1112\u1161\u11AB', 'h'];
  const text = (n: number) => Array.from({ length: n }, (_, i) => CLUSTERS[i % CLUSTERS.length]!).join('');

  it('64 / 12 characters are served whole; 65 / 13 and 70 / 15 are truncated to their first 64 / 12; the field stays usable', () => {
    for (const [n, want] of [
      [64, 64],
      [65, 64],
      [70, 64],
    ] as const) {
      const name = text(n);
      expect(characters(name)).toHaveLength(n);
      const s = one([record.utf8('name', name)]);
      expect(nameOf(s)).toBe(text(want));
      const f = s.identities()[0]!.fields[0]!;
      expect(f.usable).toBe(true);
      expect(f.storedValue === undefined).toBe(n === want);
      if (f.storedValue !== undefined) expect(Buffer.from(f.storedValue).toString()).toBe(name); // stored bytes unchanged
    }
    for (const [n, want] of [
      [12, 12],
      [13, 12],
      [15, 12],
    ] as const)
      expect(symbolOf(one([record.utf8('symbol', text(n))]))).toBe(text(want));
  });

  it('a character is a grapheme cluster: never split, and neither code points nor bytes are counted', () => {
    const name = text(70);
    expect(Array.from(name).length).toBeGreaterThan(90); // code points
    expect(nameOf(one([record.utf8('name', name)]))).toBe(text(64));
    // Counting code points would cut inside a cluster (the flag's two regional indicators, the jamo L+V+T).
    expect(Array.from(name).slice(0, 64).join('')).not.toBe(text(64));
    expect(truncateCharacters(Buffer.from('ab\u1112\u1161\u11ABc'), 3)).toEqual({
      value: new Uint8Array(Buffer.from('ab\u1112\u1161\u11AB')),
      truncated: true,
    });
    expect(truncateCharacters(Buffer.from('ab\u{1F1FA}\u{1F1FE}'), 3).truncated).toBe(false);
    // One code point per character, several bytes each: 70 characters in 200 bytes keep 64 characters.
    const multi = 'é'.repeat(30) + '名'.repeat(20) + '😀'.repeat(20);
    expect(Buffer.byteLength(multi)).toBe(200);
    expect(nameOf(one([record.utf8('name', multi)]))).toBe('é'.repeat(30) + '名'.repeat(20) + '😀'.repeat(14));
    expect(symbolOf(one([record.utf8('symbol', '😀'.repeat(15))]))).toBe('😀'.repeat(12));
  });

  it('only name and symbol are truncated, and only usable type-1 values', () => {
    const long = 'x'.repeat(100);
    expect(servedValue(hex('standards'), 1, Buffer.from(long))).toHaveLength(100);
    expect(servedValue(NAME, 0, Buffer.from(long))).toHaveLength(100); // bytes: unusable, served as stored
    expect(servedValue(NAME, 1, Buffer.from(long))).toHaveLength(64);
  });

  it('marked history serves the truncated value too', () => {
    const s = one([record.utf8('name', 'y'.repeat(70))]);
    s.apply(ev(3, [record.utf8('name', 'Short')]));
    expect(s.history(s.identities()[0]!.key, NAME).map((h) => h.value.length)).toEqual([64]);
  });

  it('grouping compares the stored symbol bytes: two 15-character symbols that share their first 12 form two groups', () => {
    const s = new MetadataState();
    s.apply(ev(1, [record.utf8('symbol', 'ACMEACMEACME-AA')], { domainSep: D }));
    s.apply(ev(3, [record.utf8('symbol', 'ACMEACMEACME-AA')], { domainSep: D }));
    s.apply(ev(1, [record.utf8('symbol', 'ACMEACMEACME-BB')], { domainSep: D2 }));
    const groups = s.groups();
    expect(groups.map((g) => [Buffer.from(g.symbol).toString(), g.members.length]).sort()).toEqual([
      ['ACMEACMEACME-AA', 2],
      ['ACMEACMEACME-BB', 1],
    ]);
    expect(new Set(s.identities().map((i) => i.common.symbol))).toEqual(new Set(['ACMEACMEACME']));
  });
});

describe('image and image_sha256 (MIP "Common fields", S12)', () => {
  const CONTENT = Buffer.from('\x89PNG acme logo');
  const DIGEST = createHash('sha256').update(CONTENT).digest();

  it('matching content is allowed, mismatching content is refused, no image_sha256 = allowed (unchecked)', () => {
    const s = new MetadataState();
    s.apply(ev(3, [record.image('https://example.org/acme.png'), record.imageSha256(DIGEST)]));
    const v = s.identities()[0];
    expect(s.imageContentAllowed(v, CONTENT)).toBe(true);
    expect(s.imageContentAllowed(v, Buffer.from('substituted'))).toBe(false);
    const t = new MetadataState();
    t.apply(ev(3, [record.image('https://example.org/acme.png')]));
    expect(t.imageContentAllowed(t.identities()[0], Buffer.from('anything'))).toBe(true);
    expect(t.imageContentAllowed(undefined, CONTENT)).toBe(false);
  });

  it('an image_sha256 of 31 or 33 bytes, or not type 0, is unusable, and no content matches it', () => {
    for (const r of [
      record.bytes('image_sha256', DIGEST.subarray(0, 31)),
      record.bytes('image_sha256', Buffer.concat([DIGEST, Buffer.from([0])])),
      record.utf8('image_sha256', DIGEST.toString('hex').slice(0, 32)),
    ]) {
      const s = new MetadataState();
      s.apply(ev(3, [record.image('https://example.org/acme.png'), r]));
      const v = s.identities()[0]!;
      expect(v.fields.find((f) => f.keyHex === IMAGE_SHA256)!.usable).toBe(false);
      expect(v.common.imageSha256).toBeUndefined();
      expect(s.imageContentAllowed(v, CONTENT)).toBe(false);
    }
  });

  it('image must be a URI (type 4); a type-1 string is unusable', () => {
    const s = new MetadataState();
    s.apply(ev(3, [record.utf8('image', 'https://example.org/acme.png')]));
    expect(s.identities()[0]!.fields[0]!.usable).toBe(false);
    expect(s.identities()[0]!.common.image).toBeUndefined();
  });

  it('imageContentAllowed on its own', () => {
    expect(imageContentAllowed(undefined, CONTENT)).toBe(true);
    expect(imageContentAllowed(DIGEST, CONTENT)).toBe(true);
    expect(imageContentAllowed(DIGEST.subarray(0, 31), CONTENT)).toBe(false);
  });
});
