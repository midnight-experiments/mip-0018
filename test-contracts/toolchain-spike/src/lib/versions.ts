// SPDX-License-Identifier: Apache-2.0
//
// The toolchain a spike run actually used, read from the installed packages and
// the compiler output (not from what we think we pinned).

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { managedDir } from './providers.js';

const require = createRequire(import.meta.url);

const pkgVersion = (name: string): string => {
  for (const dir of require.resolve.paths(name) ?? []) {
    try {
      const p = JSON.parse(readFileSync(join(dir, name, 'package.json'), 'utf8')) as { version?: string };
      if (p.version) return p.version;
    } catch {
      /* not in this node_modules */
    }
  }
  return '?';
};

export const toolchain = (contract: string): Record<string, string> => {
  const info = JSON.parse(readFileSync(join(managedDir(contract), 'compiler', 'contract-info.json'), 'utf8')) as Record<string, string>;
  return {
    compactCompiler: `${info['compiler-version']} (${String(info['compiler-commit']).slice(0, 9)})`,
    compactLanguage: String(info['language-version']),
    compactRuntime: pkgVersion('@midnight-ntwrk/compact-runtime'),
    zkir: 'v3 (--feature-zkir-v3)',
    ledgerV9: pkgVersion('@midnightntwrk/ledger-v9'),
    compactJs: pkgVersion('@midnight-ntwrk/compact-js'),
    midnightJs: pkgVersion('@midnight-ntwrk/midnight-js-contracts'),
    walletSdk: pkgVersion('@midnightntwrk/wallet-sdk'),
    walletSdkFacade: pkgVersion('@midnightntwrk/wallet-sdk-facade'),
    node: process.version,
  };
};
