// SPDX-License-Identifier: Apache-2.0
//
// The one writer of the repository's public JSON files: run records, scanner states, network files
// (`deployments/<network>/network.json`) and the local tools' records. Every file is written from `publicCopy`
// (redact.ts) of its value, so no registered token, no `project_id` value and no URL credentials reach it, published
// values (the file's `exact` paths) keep every byte but a registered token, and the caller's value is not changed.
// The text is written atomically: a temporary file in the same directory, an optional fsync, a rename.

import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { toJson } from './hex.ts';
import { publicCopy, removeSecrets, type PublicFileRules } from './redact.ts';

export interface PublicJsonOptions extends PublicFileRules {
  /** JSON indentation (default 2). */
  indent?: number;
  /** fsync before the rename (a checkpoint that must survive a crash). */
  fsync?: boolean;
}

/** The text of a public JSON file: `publicCopy` of the value, serialised with `toJson`, without any registered secret. */
export function publicJsonText(value: unknown, o: PublicJsonOptions = {}): string {
  return removeSecrets(`${toJson(publicCopy(value, o), o.indent ?? 2)}\n`);
}

/** Writes `publicJsonText(value)` to `path` atomically (the directory is created when missing). */
export function writePublicJson(path: string, value: unknown, o: PublicJsonOptions = {}): void {
  const text = publicJsonText(value, o);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w', 0o644);
  try {
    writeSync(fd, text);
    if (o.fsync) fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}
