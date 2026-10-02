// SPDX-License-Identifier: Apache-2.0
//
// Record / replay of JSON-over-HTTP exchanges, so unit tests run the real clients against recorded Stagenet
// responses without a network. A cassette is a list of { url, body, response }; replay matches on url + body
// (JSON-normalised) and serves each recorded exchange once per occurrence, in order.

import { readFileSync, writeFileSync } from 'node:fs';

export interface Exchange {
  url: string;
  body: unknown;
  status: number;
  response: unknown;
}

const key = (url: string, body: unknown) => `${url} ${JSON.stringify(body)}`;

/** A fetch that performs the real request and appends the exchange to `tape`. */
export function recordingFetch(tape: Exchange[], real: typeof fetch = fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const res = await real(input, init);
    const text = await res.text();
    let response: unknown = text;
    try {
      response = JSON.parse(text);
    } catch {
      /* keep text */
    }
    tape.push({ url, body, status: res.status, response });
    return new Response(text, { status: res.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

/** A fetch that serves recorded exchanges; unknown requests fail the test loudly. */
export function replayFetch(tape: Exchange[], o: { repeat?: boolean } = {}): typeof fetch & { misses: string[] } {
  const queues = new Map<string, Exchange[]>();
  for (const e of tape) {
    const k = key(e.url, e.body);
    queues.set(k, [...(queues.get(k) ?? []), e]);
  }
  const misses: string[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const q = queues.get(key(url, body));
    if (!q || q.length === 0) {
      misses.push(key(url, body).slice(0, 300));
      throw new Error(`no recorded response for ${key(url, body).slice(0, 300)}`);
    }
    const e = o.repeat && q.length === 1 ? q[0]! : q.shift()!;
    return new Response(typeof e.response === 'string' ? e.response : JSON.stringify(e.response), {
      status: e.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch & { misses: string[] };
  f.misses = misses;
  return f;
}

export function loadTape(path: string): Exchange[] {
  return JSON.parse(readFileSync(path, 'utf8')) as Exchange[];
}

export function saveTape(path: string, tape: Exchange[]): void {
  writeFileSync(path, `${JSON.stringify(tape, null, 1)}\n`);
}
