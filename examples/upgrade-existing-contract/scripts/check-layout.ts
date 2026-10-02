// SPDX-License-Identifier: Apache-2.0
//
// Ledger layout check for an upgrade-only source (docs/upgrade-guide.md, step 2).
//
//   node scripts/check-layout.ts [--legacy <file.compact | managed dir>] [--upgrade <file.compact | managed dir>]
//                                [--compact-path <dir>] [--json]
//
// Defaults: legacy/LegacyToken.compact and upgrade/LegacyTokenMetadata.compact. A source file is compiled with
// --skip-zk into a temporary directory (run it in the toolchain image: docker/run.sh exec '…'); a directory is read as
// compactc output (e.g. the build the deployed contract came from). Compares the compiler's ledger layout
// (compiler/contract-info.json) field by field: same fields, same order, same storage and types, same names.
// Exit 0 identical · 1 different · 2 usage or compile error.
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { compareLayouts, layoutOf } from '@mip0018/midnight';
import { LEGACY, UPGRADE } from '../src/contracts.ts';

try {
  const { values } = parseArgs({
    options: {
      legacy: { type: 'string', default: LEGACY.source },
      upgrade: { type: 'string', default: UPGRADE.source },
      'compact-path': { type: 'string', default: join(import.meta.dirname, '..', '..', '..', 'node_modules') },
      json: { type: 'boolean', default: false },
    },
  });
  const o = { compactPath: values['compact-path'] };
  const legacy = layoutOf(values.legacy, o);
  const upgrade = layoutOf(values.upgrade, o);
  const c = compareLayouts(legacy, upgrade);
  if (values.json) {
    process.stdout.write(
      `${JSON.stringify({ legacy: legacy.from, upgrade: upgrade.from, compilers: [legacy.compiler, upgrade.compiler], ...c }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(
      `deployed  ${legacy.from}  (compactc ${legacy.compiler})\nupgrade   ${upgrade.from}  (compactc ${upgrade.compiler})\n\n`,
    );
    const w = Math.max(8, ...c.rows.map((r) => (r.legacy ?? '').length));
    process.stdout.write(`  #  ${'deployed'.padEnd(w)}  upgrade\n`);
    for (const r of c.rows)
      process.stdout.write(`${r.same ? ' ' : '✗'}${String(r.index).padStart(2)}  ${(r.legacy ?? '—').padEnd(w)}  ${r.upgrade ?? '—'}\n`);
    for (const n of c.notes) process.stdout.write(`note: ${n}\n`);
    for (const p of c.problems) process.stdout.write(`LAYOUT MISMATCH ${p}\n`);
    process.stdout.write(
      c.identical
        ? `\nOK: identical ledger layout (${legacy.fields.length} fields)\n`
        : `\nFAILED: the upgrade source would read and write the deployed state at other places; copy the deployed ledger declarations verbatim\n`,
    );
  }
  process.exitCode = c.identical ? 0 : 1;
} catch (e) {
  process.stderr.write(`check-layout: ${(e as Error).message}\n`);
  process.exitCode = 2;
}
