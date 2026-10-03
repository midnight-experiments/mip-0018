// SPDX-License-Identifier: Apache-2.0
//
// Which MIP-0018 commit does a text cite? The repository cites exactly one: the pin in toolchain.json.
// Two detectors, both pure functions (tools/check-mip-pin.mjs feeds them every tracked file):
//
//   structural  a link or reference into the MIP repository that names a commit
//               (".../midnight-improvement-proposals/blob/<sha>/...", "midnight-improvement-proposals@<sha>",
//               raw.githubusercontent.com URLs) whose commit is not the pin
//   known       any other commit of the MIP text (the proposal's commits and the commits that changed the file,
//               listed by the GitHub API at check time) cited by its first 7 or more hex digits

const MIP_REPO = 'midnight-improvement-proposals';

/** True when `sha` (7–40 hex digits) names the pinned commit. */
export const isPin = (sha, pin) => sha.length >= 7 && pin.startsWith(sha.toLowerCase());

/**
 * Citations of MIP commits other than `pin` in `text`: [{ line, sha, how }]. `known` lists other commits of the MIP
 * text (full 40-digit SHAs); a known commit counts when its first 7 or more digits appear as a whole hex word.
 */
export function foreignMipCitations(text, pin, known = []) {
  const hits = [];
  const lines = text.split('\n');
  const structural = new RegExp(`${MIP_REPO}(?:/(?:blob|tree|raw|commit)/|@|/)([0-9a-fA-F]{7,40})\\b`, 'gu');
  const others = known.map((s) => s.toLowerCase()).filter((s) => !isPin(s, pin) && /^[0-9a-f]{40}$/u.test(s));
  lines.forEach((l, i) => {
    for (const m of l.matchAll(structural)) if (!isPin(m[1], pin)) hits.push({ line: i + 1, sha: m[1], how: 'link' });
    if (others.length === 0) return;
    for (const m of l.matchAll(/\b[0-9a-f]{7,40}\b/gu)) {
      const w = m[0];
      const linked = hits.some((h) => h.line === i + 1 && h.sha.toLowerCase() === w);
      if (!linked && others.some((s) => s.startsWith(w))) hits.push({ line: i + 1, sha: w, how: 'known commit' });
    }
  });
  return hits;
}

/**
 * The other commits of the MIP text, from the GitHub API: the commits of the proposal's pull request and the
 * commits that changed the file on the default branch. Throws when the API cannot be read. With a token (CI passes
 * the workflow's read-only `GITHUB_TOKEN`) the requests are authenticated, so shared-runner rate limits do not apply.
 */
export async function mipTextCommits(mip, { fetchImpl = fetch, token = process.env.GITHUB_TOKEN } = {}) {
  const pr = /\/pull\/(\d+)$/u.exec(mip.pullRequest)?.[1];
  const api = `https://api.github.com/repos/${mip.repository}`;
  const urls = [
    ...(pr ? [`${api}/pulls/${pr}/commits?per_page=100`] : []),
    `${api}/commits?path=${encodeURIComponent(mip.path)}&per_page=100`,
  ];
  const shas = new Set();
  for (const url of urls) {
    const res = await fetchImpl(url, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'mip0018-check-mip-pin',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    for (const c of await res.json()) if (typeof c?.sha === 'string') shas.add(c.sha.toLowerCase());
  }
  return [...shas];
}
