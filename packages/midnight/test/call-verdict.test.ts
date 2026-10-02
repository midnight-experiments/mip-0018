// SPDX-License-Identifier: Apache-2.0
//
// A publish whose expected events are missing: an included PARTIAL_SUCCESS transaction is a failure (its logging
// segment failed and the events will never appear), anything else is waited for (audit finding F-N2).
import { describe, expect, it } from 'vitest';
import { missingEventsVerdict } from '../src/signer/index.ts';

describe('missingEventsVerdict', () => {
  it('is ok once every expected event is observed', () => {
    expect(missingEventsVerdict('SUCCESS', 1, 1)).toBe('ok');
    expect(missingEventsVerdict('PARTIAL_SUCCESS', 3, 3)).toBe('ok');
  });
  it('fails a PARTIAL_SUCCESS transaction with missing events', () => {
    expect(missingEventsVerdict('PARTIAL_SUCCESS', 1, 0)).toBe('failed');
    expect(missingEventsVerdict('PARTIAL_SUCCESS', 3, 1)).toBe('failed');
  });
  it('waits for any other status (the indexer may still be catching up)', () => {
    expect(missingEventsVerdict('SUCCESS', 1, 0)).toBe('wait');
    expect(missingEventsVerdict(undefined, 2, 1)).toBe('wait');
  });
});
