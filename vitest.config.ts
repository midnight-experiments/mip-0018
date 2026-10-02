// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'tools/test/**/*.test.ts',
      'vectors/**/*.test.ts',
      'packages/*/test/**/*.test.ts',
      'packages/*/src/**/*.test.ts',
      'examples/**/test/**/*.test.ts',
      'test-contracts/*/test/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/managed/**'],
    passWithNoTests: true,
    testTimeout: 60_000,
  },
});
