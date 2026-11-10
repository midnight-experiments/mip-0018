// SPDX-License-Identifier: Apache-2.0
//
// Process plumbing shared by every command-line tool of the repository (the mip0018 CLI, the example and case
// scripts): `runTool` runs a script body with `guardOutput` installed (redact.ts: everything written to stdout /
// stderr goes through `removeSecrets`; nothing else changes, so metadata values are printed exactly) and turns any
// error into one scrubbed line and an exit code, never an uncaught exception printed by Node.

import { guardOutput, scrubSecrets } from './redact.ts';

/** One scrubbed line for an error: `<tool>: <name>: <message>`. */
export function errorLine(tool: string, e: unknown): string {
  return scrubSecrets(`${tool}: ${(e as Error)?.name ?? 'Error'}: ${(e as Error)?.message ?? String(e)}\n`);
}

/**
 * Runs a tool's body with the output guard installed and exits with its code; an error is printed as one scrubbed
 * line (`errorLine`) and exits 1.
 */
export async function runTool(tool: string, body: () => Promise<number>): Promise<never> {
  guardOutput();
  let code: number;
  try {
    code = await body();
  } catch (e) {
    process.stderr.write(errorLine(tool, e));
    code = 1;
  }
  process.exit(code);
}
