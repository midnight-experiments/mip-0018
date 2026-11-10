// SPDX-License-Identifier: Apache-2.0
//
// Redaction of the URLs and secrets this repository writes.
//
// A Blockfrost project token travels in the query string of every preprod / mainnet request (`project_id`), so no
// endpoint URL is ever written with its query string: every log line, error message and report that shows an endpoint
// goes through `redactUrl` (one URL) or `redactUrls` (every URL inside a text, e.g. an error message from a library).
// Both cut the query string, the fragment and any `user:password@` part, and empty every `project_id` value written in
// any form (`project_id=…`, `project_id%3D…`, `"project_id": "…"`, `project_id: …`, `'project_id' => '…'`).
//
// `removeSecrets` replaces the literal value of every token registered with `registerSecret` (a profile registers the
// token it read), so a token that reached a text by any path is not written. `scrubSecrets` = both, for messages.
//
// Two structural boundaries use them:
//   - `ScrubbedError`: every error class of this package that can carry server or transport text extends it; its
//     message (and its cause, kept only as a scrubbed description) is scrubbed when the error is built, so no caller,
//     log or record receives an echoed token or token-bearing URL through one of them;
//   - `scrubDeep`: a value written to a file (a run record) has every string scrubbed with `scrubValue`, which keeps
//     data such as a metadata URL with its own query string but removes credentials, `project_id` values and
//     registered tokens, so a new field cannot carry a secret to disk.

/** The query parameter Blockfrost reads the project token from. */
export const TOKEN_PARAM = 'project_id';

const SCHEME_URL = /\b(?:https?|wss?):\/\/[^\s"'<>`]+/giu;
/** `project_id` followed by `=`, `%3D`, `:` or `=>` (optionally quoted on either side) and a value. */
const TOKEN_ASSIGNMENT = new RegExp(`(["']?${TOKEN_PARAM}["']?\\s*(?:=>|=|%3D|:)\\s*["']?)([^&#\\s"'<>\`,;)}[\\]]+)`, 'giu');
const URL_CREDENTIALS = /\b((?:https?|wss?):\/\/)[^/\s"'<>`@]*@/giu;
const REDACTED = '[redacted]';

/** One URL without its query string, fragment and credentials (unchanged otherwise). */
export function redactUrl(url: string): string {
  const cut = url.search(/[?#]/u);
  const base = cut === -1 ? url : url.slice(0, cut);
  return base.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/iu, '$1');
}

/** Every `project_id` value of a text emptied, whatever the notation (nothing else changes). */
export function redactTokenAssignments(text: string): string {
  return text.replace(TOKEN_ASSIGNMENT, `$1${REDACTED}`);
}

/** Every http(s) / ws(s) URL of a text through `redactUrl`, and any remaining `project_id` value emptied. */
export function redactUrls(text: string): string {
  return redactTokenAssignments(text.replace(SCHEME_URL, (u) => redactUrl(u)));
}

const secrets = new Set<string>();

/** Registers a secret value (e.g. a Blockfrost project token) that `scrubSecrets` removes from any text. */
export function registerSecret(value: string): void {
  if (value.length >= 8) secrets.add(value);
}

/** Every registered secret value replaced (nothing else changes: safe on any output). */
export function removeSecrets(text: string): string {
  let t = text;
  for (const s of secrets) if (t.includes(s)) t = t.split(s).join(REDACTED);
  return t;
}

/** A message for a log, an error or a report: `redactUrls`, then `removeSecrets`. Truncate only after this. */
export function scrubSecrets(text: string): string {
  return removeSecrets(redactUrls(text));
}

/**
 * A data string (a value in a written file): URL credentials, `project_id` values and registered secrets removed; a
 * URL keeps its path and any other query parameter, so published values (e.g. an image URL) stay exact.
 */
export function scrubValue(text: string): string {
  return removeSecrets(redactTokenAssignments(text.replace(URL_CREDENTIALS, '$1')));
}

const isContainer = (v: unknown): v is Record<string, unknown> | unknown[] =>
  Array.isArray(v) || (v !== null && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v) as object | null));

/**
 * Scrubs a JSON-like value IN PLACE (objects keep their identity, so holders of a nested object see the result):
 * every string and every object key through `scrubValue`, and the value of a `project_id` key replaced whole.
 * Returns the same value; a bare string is returned scrubbed.
 */
export function scrubDeep<T>(value: T): T {
  if (typeof value === 'string') return scrubValue(value) as T;
  const seen = new Set<unknown>();
  const walk = (v: unknown): void => {
    if (!isContainer(v) || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      v.forEach((x, i) => {
        if (typeof x === 'string') v[i] = scrubValue(x);
        else walk(x);
      });
      return;
    }
    for (const k of Object.keys(v)) {
      const x = v[k];
      const key = scrubValue(k);
      const next = k.toLowerCase() === TOKEN_PARAM && typeof x === 'string' ? REDACTED : typeof x === 'string' ? scrubValue(x) : x;
      if (key !== k) delete v[k];
      v[key] = next;
      walk(next);
    }
  };
  walk(value);
  return value;
}

/** The text of an error and its causes (name: message <- cause …), for a scrubbed cause. */
function causeText(e: unknown, depth = 0): string {
  if (e === null || e === undefined || depth > 8) return '';
  if (typeof e !== 'object') return String(e);
  const o = e as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
  const head = [o.name, o.code, o.message].filter((x) => typeof x === 'string' && x !== '').join(': ');
  const next = causeText(o.cause, depth + 1);
  return [head, next].filter((x) => x !== '').join(' <- ');
}

/**
 * An error whose message is scrubbed (`scrubSecrets`) when it is built. A `cause` is kept only as a plain `Error`
 * holding the scrubbed text of the cause chain, never as the original object.
 */
export class ScrubbedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(scrubSecrets(message), options?.cause === undefined ? undefined : { cause: new Error(scrubSecrets(causeText(options.cause))) });
  }
}
