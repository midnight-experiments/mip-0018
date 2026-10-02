// SPDX-License-Identifier: Apache-2.0
//
// Compile-time guarantees of the module (Compact 0.35.0, --feature-zkir-v3): each fixture in
// test/compile-fail/ must be REJECTED by the compiler with the given message. Among them: a
// constructor cannot emit (MIP "Publishing": hence the `publishMetadata()` convention), and every
// size rule of the payload is a static error for both constructions.

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileError } from '../src/testing/index.ts';

const DIR = join(import.meta.dirname, 'compile-fail');
const OUT_OF_BOUNDS = 'slice index 0 plus length 1 is out-of-bounds for a Bytes value of length 0';

const CASES: [fixture: string, message: string | RegExp][] = [
  ['ConstructorEmitsDirectly', 'constructor cannot emit an event but emits event Misc'],
  [
    'ConstructorEmitsViaModule',
    /constructor cannot emit an event but calls \(directly or indirectly\) emitPayload, which emits\s+event Misc/u,
  ],
  [
    'PureCircuitEmits',
    /circuit publish is marked pure but is actually impure because it calls \(directly or indirectly\)\s+impure circuit emitPayload/u,
  ],
  ['TypedEmptyKey', OUT_OF_BOUNDS],
  ['TypedEmptyName', OUT_OF_BOUNDS],
  ['TypedEmptySymbol', OUT_OF_BOUNDS],
  ['TypedKeyTooLong', /mismatch between actual type Uint<0\.\.257> and declared type Uint<8> for field keyLen/u],
  ['TypedValueTooLong', /mismatch between actual type Uint<0\.\.257> and declared type Uint<8> for field valLen/u],
  ['TypedOverflow', 'actual serialized size 257 exceeds specified length 256'],
  ['TypedWrongValueSize', /no compatible function named M_utf8Record[\s\S]*\(Bytes<4>, Bytes<10>\)/u],
  ['TypedDecimalsTooLarge', /no compatible function named M_decimalsRecord[\s\S]*\(Uint<0\.\.257>\)/u],
  ['PureEmptyKey', OUT_OF_BOUNDS],
  ['PureWrongRecordSize', /mismatch between actual return type Bytes<17> and declared return type Bytes<16> of circuit\s+rawRecord/u],
  ['PureWrongPadding', /mismatch between actual return type Bytes<255> and declared return type Bytes<256> of circuit\s+payload1/u],
  ['PureOverflow', /mismatch between actual return type Bytes<257> and declared return type Bytes<256> of circuit\s+payload1/u],
  [
    'UndisclosedRawEmit',
    /potential witness-value disclosure must be declared but is not[\s\S]*emit operation might disclose the witness value/u,
  ],
];

describe('compile-time rejection (Compact 0.35.0, ZKIR v3)', () => {
  it.each(CASES)('%s is rejected', (fixture, message) => {
    const out = compileError(join(DIR, `${fixture}.compact`));
    if (typeof message === 'string') expect(out).toContain(message);
    else expect(out).toMatch(message);
  });
});
