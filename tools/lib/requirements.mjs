// SPDX-License-Identifier: Apache-2.0
//
// Mechanical extraction of the MIP's normative sentences: every sentence (or
// table row) containing the RFC 2119 keyword MUST or SHOULD, with the section
// it appears in. The conformance matrix must list exactly these.

const KEYWORD = /\b(MUST|SHOULD)\b/u;

/** Collapses whitespace so wrapping and Markdown table escaping do not matter. */
export const normalize = (s) => s.replace(/\\\|/gu, '|').replace(/\s+/gu, ' ').trim();

/** Splits a paragraph or list item into sentences without breaking "e.g." or "i.e.". */
export const sentences = (line) => {
  const protectedLine = line.replace(/\b(e\.g|i\.e|etc)\./gu, (m) => m.replace(/\./gu, '\u0000'));
  return protectedLine
    .split(/(?<=[.!?])\s+(?=[A-Z*`"([])/u)
    .map((s) => s.replace(/\u0000/gu, '.').trim())
    .filter(Boolean);
};

/**
 * @param {string} text the MIP Markdown
 * @returns {{ id: string, section: string, level: string, text: string }[]}
 */
export const extractRequirements = (text) => {
  const out = [];
  const headings = [];
  let inFence = false;
  for (const raw of text.split(/\r?\n/u)) {
    if (/^\s*```/u.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const h = /^(#{1,6})\s+(.*)$/u.exec(raw);
    if (h) {
      headings.length = h[1].length - 1;
      headings[h[1].length - 1] = h[2].trim();
      continue;
    }
    const line = raw.trim();
    if (!KEYWORD.test(line)) continue;
    if (/RFC 2119/u.test(line)) continue; // the keyword boilerplate itself
    const section = headings.filter(Boolean).slice(1).join(' > ') || headings.filter(Boolean)[0] || '';
    const units = line.startsWith('|') ? [line] : sentences(line.replace(/^([-*]|\d+\.)\s+/u, ''));
    for (const u of units) {
      if (!KEYWORD.test(u)) continue;
      const level = /\bMUST\b/u.test(u) ? (/\bSHOULD\b/u.test(u) ? 'MUST/SHOULD' : 'MUST') : 'SHOULD';
      out.push({ id: '', section, level, text: normalize(u) });
    }
  }
  return out.map((r, i) => ({ ...r, id: `C-${String(i + 1).padStart(3, '0')}` }));
};
