// SPDX-License-Identifier: Apache-2.0
// The MIP-citation detectors behind `check:mip-pin`, with synthetic commits (positive and negative controls).
import { describe, expect, it } from 'vitest';
import { foreignMipCitations, isPin, mipTextCommits } from '../lib/mip-citations.mjs';

const PIN = '1234567890abcdef1234567890abcdef12345678';
const OTHER = 'fedcba0987654321fedcba0987654321fedcba09';
const REPO = 'midnightntwrk/midnight-improvement-proposals';

describe('MIP citations', () => {
  it('accepts citations of the pin, abbreviated or in full, as text or as a link', () => {
    const text = `pinned \`${PIN.slice(0, 7)}\`\nhttps://github.com/${REPO}/blob/${PIN}/mips/x.md\n${REPO}@${PIN.slice(0, 8)}`;
    expect(foreignMipCitations(text, PIN, [OTHER])).toEqual([]);
    expect(isPin(PIN.slice(0, 7), PIN)).toBe(true);
    expect(isPin(OTHER.slice(0, 7), PIN)).toBe(false);
  });

  it('catches another known commit of the MIP text, abbreviated (positive control)', () => {
    expect(foreignMipCitations(`the MIP text \`${OTHER.slice(0, 7)}\``, PIN, [OTHER])).toEqual([
      { line: 1, sha: OTHER.slice(0, 7), how: 'known commit' },
    ]);
  });

  it('catches a link into the MIP repository that names another commit, even an unknown one', () => {
    const unknown = 'aaaaaaabbbbbbbccccccc';
    const hits = foreignMipCitations(`x\nhttps://raw.githubusercontent.com/${REPO}/${unknown}/mips/x.md`, PIN, []);
    expect(hits).toEqual([{ line: 2, sha: unknown, how: 'link' }]);
  });

  it('reports a link to a known commit once', () => {
    expect(foreignMipCitations(`https://github.com/${REPO}/blob/${OTHER}/mips/x.md`, PIN, [OTHER])).toEqual([
      { line: 1, sha: OTHER, how: 'link' },
    ]);
  });

  it('ignores 64-digit hashes and short hex words that are not known commits', () => {
    const text = `tx ${'ab'.repeat(32)}\nkey ${OTHER.slice(0, 6)} and deadbeef`;
    expect(foreignMipCitations(text, PIN, [OTHER])).toEqual([]);
  });

  it('lists the commits of the proposal and of the file through the GitHub API', async () => {
    const seen: string[] = [];
    const fetchImpl = async (url: string) => {
      seen.push(url);
      return { ok: true, json: async () => [{ sha: url.includes('/pulls/') ? OTHER : PIN }] };
    };
    const mip = { repository: REPO, path: 'mips/x.md', pullRequest: `https://github.com/${REPO}/pull/340` };
    expect((await mipTextCommits(mip, { fetchImpl })).sort()).toEqual([PIN, OTHER].sort());
    expect(seen[0]).toContain('/pulls/340/commits');
    expect(seen[1]).toContain('commits?path=mips%2Fx.md');
  });

  it('authenticates the API requests with a token, and sends none without one', async () => {
    const auth: (string | undefined)[] = [];
    const fetchImpl = async (_url: string, init?: unknown) => {
      auth.push((init as { headers?: Record<string, string> } | undefined)?.headers?.authorization);
      return { ok: true, json: async () => [] };
    };
    const mip = { repository: REPO, path: 'mips/x.md', pullRequest: `https://github.com/${REPO}/pull/340` };
    await mipTextCommits(mip, { fetchImpl, token: 'test-token' });
    await mipTextCommits(mip, { fetchImpl, token: '' });
    expect(auth).toEqual(['Bearer test-token', 'Bearer test-token', undefined, undefined]);
  });
});
