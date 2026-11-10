// SPDX-License-Identifier: Apache-2.0
//
// Redaction of the URLs and secrets this repository writes.
//
// A Blockfrost project token travels in the query string of every preprod / mainnet request (`project_id`), so no
// endpoint URL is ever written with its query string: every log line, error message and report that shows an endpoint
// goes through `redactUrl` (one URL) or `redactUrls` (every URL inside a text, e.g. an error message from a library).
// Both cut the query string, the fragment and any `user:password@` part of a URL's authority, and empty every
// `project_id` value written in any form (`project_id=…`, `project_id%3D…`, `"project_id": "…"`, `project_id: …`,
// `'project_id' => '…'`).
//
// `removeSecrets` replaces the literal value of every token registered with `registerSecret` (a profile registers the
// token it read), so a token that reached a text by any path is not written. `scrubSecrets` = both, for messages.
//
// Three structural boundaries use them:
//   - `ScrubbedError`: every error class of this package that can carry server or transport text extends it; its
//     message (and its cause, kept only as a scrubbed description) is scrubbed when the error is built, so no caller,
//     log or record receives an echoed token or token-bearing URL through one of them;
//   - `publicCopy` (and `writePublicJson`, public-file.ts, the one writer of every public JSON file): a copy of the
//     value in which published values (the paths a file names `exact`, e.g. circuit arguments) keep every byte but a
//     registered token, messages and endpoint URLs go through `scrubSecrets`, and every other string and key through
//     `scrubValue` (credentials in a URL's authority, `project_id` values and registered tokens removed); the value
//     itself is never changed;
//   - `guardOutput`: once a secret is registered, everything the process writes to stdout / stderr goes through
//     `removeSecrets` (installed by `registerSecret`, so a process holding a token cannot print it).

/** The query parameter Blockfrost reads the project token from. */
export const TOKEN_PARAM = 'project_id';

const SCHEME_URL = /\b(?:https?|wss?):\/\/[^\s"'<>`]+/giu;
/** `project_id` followed by `=`, `%3D`, `:` or `=>` (optionally quoted on either side) and a value. */
const TOKEN_ASSIGNMENT = new RegExp(`(["']?${TOKEN_PARAM}["']?\\s*(?:=>|=|%3D|:)\\s*["']?)([^&#\\s"'<>\`,;)}[\\]]+)`, 'giu');
/** The `user:password@` part of a URL's authority: up to the last `@` before the path, query or fragment. */
const URL_CREDENTIALS = /\b((?:https?|wss?):\/\/)[^/?#\s"'<>`]*@/giu;
const REDACTED = '[redacted]';

/** One URL without its query string, fragment and credentials (unchanged otherwise). */
export function redactUrl(url: string): string {
  const cut = url.search(/[?#]/u);
  const base = cut === -1 ? url : url.slice(0, cut);
  return base.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/iu, '$1');
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

/**
 * Registers a secret value (e.g. a Blockfrost project token) that `removeSecrets` / `scrubSecrets` remove from any
 * text, and installs `guardOutput`, so the process never writes it to stdout or stderr.
 */
export function registerSecret(value: string): void {
  if (value.length < 8) return;
  secrets.add(value);
  guardOutput();
}

let guarded = false;

/**
 * Filters everything written to stdout / stderr through `removeSecrets` (installed once per process; `registerSecret`
 * installs it). Nothing else changes, so metadata values are printed exactly.
 */
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
 * A data string of a public file: credentials in a URL's authority, `project_id` values and registered secrets
 * removed; a URL keeps its path, query and fragment. Idempotent.
 */
export function scrubValue(text: string): string {
  return removeSecrets(redactTokenAssignments(text.replace(URL_CREDENTIALS, '$1')));
}

/** A path into a JSON value: object keys and array indices (as strings); `*` matches any one of them. */
export type JsonPathPattern = readonly string[];

/** Where a public file holds published values and messages (see `publicCopy`). */
export interface PublicFileRules {
  /** Published values (e.g. circuit arguments, decoded ledger state): every string and key keeps every byte but a registered secret. A pattern covers its whole subtree. */
  exact?: readonly JsonPathPattern[];
  /** Messages and endpoint URLs (one string each): `scrubSecrets`. */
  messages?: readonly JsonPathPattern[];
}

const matchesAt = (pattern: JsonPathPattern, path: readonly string[]): boolean => pattern.every((p, i) => p === '*' || p === path[i]);

/**
 * A copy of a JSON-like value for a public file; the value is never changed. Strings and object keys under an `exact`
 * pattern go through `removeSecrets` (published values stay byte for byte), strings at a `messages` pattern through
 * `scrubSecrets`, and every other string and key through `scrubValue`, with the value of a `project_id` key replaced
 * whole. Byte arrays, bigints and other non-plain values are kept as they are (the serialiser writes them). Applying it
 * to its own result changes nothing.
 */
export function publicCopy<T>(value: T, rules: PublicFileRules = {}): T {
  const exact = rules.exact ?? [];
  const messages = rules.messages ?? [];
  const walk = (v: unknown, path: string[], inExact: boolean): unknown => {
    if (typeof v === 'string') {
      if (inExact) return removeSecrets(v);
      if (messages.some((m) => m.length === path.length && matchesAt(m, path))) return scrubSecrets(v);
      return scrubValue(v);
    }
    if (v === null || typeof v !== 'object' || ArrayBuffer.isView(v)) return v;
    if (Array.isArray(v)) return v.map((x, i) => walk(x, [...path, String(i)], inExact));
    const proto = Object.getPrototypeOf(v) as object | null;
    if (proto !== Object.prototype && proto !== null) {
      const json = (v as { toJSON?: () => unknown }).toJSON;
      if (typeof json === 'function') return walk(json.call(v), path, inExact);
      if (v instanceof Map) return walk(Object.fromEntries(v), path, inExact);
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const p = [...path, k];
      const under = inExact || exact.some((e) => e.length <= p.length && matchesAt(e, p));
      out[under ? removeSecrets(k) : scrubValue(k)] =
        !under && k.toLowerCase() === TOKEN_PARAM && typeof x === 'string' ? REDACTED : walk(x, p, under);
    }
    return out;
  };
  return walk(
    value,
    [],
    exact.some((e) => e.length === 0),
  ) as T;
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
