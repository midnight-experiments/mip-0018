// SPDX-License-Identifier: Apache-2.0
//
// Process plumbing shared by every command-line tool of the repository (the mip0018 CLI, the example and case
// scripts): `guardOutput` filters everything the process writes to stdout / stderr through `removeSecrets` (no
// registered token leaves the process; nothing else changes, so metadata values are printed exactly), and `runTool`
// runs a script body under that guard and turns any error into one scrubbed line and an exit code, never an uncaught
// exception printed by Node.

import { removeSecrets, scrubSecrets } from './redact.ts';

let guarded = false;

/** Filters everything written to stdout / stderr through `removeSecrets` (installed once per process). */
export function guardOutput(): void {
  if (guarded) return;
  guarded = true;
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      const text = typeof chunk === 'string' ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8') : undefined;
      if (text === undefined) return write(chunk, ...rest);
      const clean = removeSecrets(text);
      return write(clean === text ? chunk : clean, ...rest);
    }) as typeof stream.write;
  }
}

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
