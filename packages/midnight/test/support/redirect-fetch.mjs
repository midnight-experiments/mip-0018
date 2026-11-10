// SPDX-License-Identifier: Apache-2.0
//
// Test support, loaded with `node --import`: routes every fetch to an origin named in REDIRECT_FETCH (JSON
// {"<origin>": "<base URL>"}) to that base URL, keeping the path and the query string, so a tool that reads a public
// network's pinned endpoints can be run against a local stub without contacting the network.

const routes = JSON.parse(process.env.REDIRECT_FETCH ?? '{}');
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  const base = routes[url.origin];
  if (base === undefined) return realFetch(input, init);
  return realFetch(`${base}${url.pathname === '/' ? '' : url.pathname}${url.search}`, init);
};
