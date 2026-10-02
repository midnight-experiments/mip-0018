// MIP Testing A1 / Appendix A: the committed A1 fixture equals the Appendix A table byte for byte, line by line.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VECTORS_DIR } from '../tools/common.ts';

// MIP-0018 @ 274a84f (unchanged since b147c62), "Appendix A: Example event (informative)", transcribed line by line.
const APPENDIX_A: Array<{ offset: number; hex: string; meaning: string }> = [
  { offset: 0, hex: '11'.repeat(32), meaning: 'domainSep' },
  { offset: 32, hex: '03', meaning: 'kind = ledger' },
  { offset: 33, hex: '04 6e616d65 01 0a 41636d6520546f6b656e', meaning: 'name = "Acme Token"' },
  { offset: 50, hex: '06 73796d626f6c 01 04 41434d45', meaning: 'symbol = "ACME"' },
  { offset: 63, hex: '08 646563696d616c73 02 01 06', meaning: 'decimals = 6 (Uint<8>)' },
  { offset: 75, hex: '09 7374616e6461726473 01 08 6d69702d30303034', meaning: 'standards = "mip-0004"' },
  { offset: 95, hex: '00'.repeat(161), meaning: 'padding' },
];

const vector = JSON.parse(readFileSync(join(VECTORS_DIR, 'payload/A1.json'), 'utf8'));
const bin = readFileSync(join(VECTORS_DIR, 'payload/A1.bin'));

describe('A1 equals MIP Appendix A', () => {
  it('the .bin file is the JSON payload_hex', () => {
    expect(bin.length).toBe(256);
    expect(bin.toString('hex')).toBe(vector.event.payload_hex);
  });

  for (const line of APPENDIX_A) {
    it(`offset ${line.offset}: ${line.meaning}`, () => {
      const hex = line.hex.replaceAll(' ', '');
      expect(bin.subarray(line.offset, line.offset + hex.length / 2).toString('hex')).toBe(hex);
    });
  }

  it('the Appendix A lines are contiguous and cover all 256 bytes', () => {
    let at = 0;
    for (const line of APPENDIX_A) {
      expect(line.offset).toBe(at);
      at += line.hex.replaceAll(' ', '').length / 2;
    }
    expect(at).toBe(256);
  });

  it('expected records sit at offsets 33, 50, 63, 75; content ends at 95; 161 zero bytes follow', () => {
    expect(vector.expect.result).toBe('accept');
    expect(vector.expect.records.map((r: { offset: number }) => r.offset)).toEqual([33, 50, 63, 75]);
    expect(vector.expect.contentEnd).toBe(95);
    expect([...bin.subarray(95)].every((b) => b === 0)).toBe(true);
    expect(256 - 95).toBe(161);
  });

  it('is bound to the v1 event name and the pinned MIP commit', () => {
    expect(vector.event.type).toBe('Misc');
    expect(vector.event.name_hex).toBe('6d69702d303031383a746f6b656e2d6d657461646174615b76315d0000000000');
    expect(vector.mip.commit).toBe('274a84f221bcfc17e4b73e2c8b32fd8c028ea092');
    expect(vector.normative).toBe(true);
  });
});
