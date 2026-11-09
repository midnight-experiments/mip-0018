// SPDX-License-Identifier: Apache-2.0
//
// Redaction of the URLs this repository writes.
//
// A Blockfrost project token travels in the query string of every preprod / mainnet request (`project_id`), so no
// URL is ever written with its query string: every log line, error message, run record, observation and report that
// shows an endpoint goes through `redactUrl` (one URL) or `redactUrls` (every URL inside a text, e.g. an error message
// from a library). Both cut the query string, the fragment and any `user:password@` part.
//
// `removeSecrets` is the last line: it replaces the literal value of every token registered with `registerSecret`
// (a profile registers the token it read; the CLI filters its whole stdout / stderr through `removeSecrets`), so a
// token that reached a message by any path is not written. `scrubSecrets` = both, for messages.

/** The query parameter Blockfrost reads the project token from. */
export const TOKEN_PARAM = 'project_id';

const SCHEME_URL = /\b(?:https?|wss?):\/\/[^\s"'<>`]+/giu;
const TOKEN_ASSIGNMENT = new RegExp(`(${TOKEN_PARAM})=[^&#\\s"'<>\`]+`, 'giu');
const REDACTED = '[redacted]';

/** One URL without its query string, fragment and credentials (unchanged otherwise). */
export function redactUrl(url: string): string {
  const cut = url.search(/[?#]/u);
  const base = cut === -1 ? url : url.slice(0, cut);
  return base.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/iu, '$1');
}

/** Every http(s) / ws(s) URL of a text through `redactUrl`, and any remaining `project_id=<value>` emptied. */
export function redactUrls(text: string): string {
  return text.replace(SCHEME_URL, (u) => redactUrl(u)).replace(TOKEN_ASSIGNMENT, `$1=${REDACTED}`);
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

/** A message for a log, an error or a record: `redactUrls`, then `removeSecrets`. */
export function scrubSecrets(text: string): string {
  return removeSecrets(redactUrls(text));
}
