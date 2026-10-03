export declare const isPin: (sha: string, pin: string) => boolean;
export declare function foreignMipCitations(
  text: string,
  pin: string,
  known?: string[],
): { line: number; sha: string; how: 'link' | 'known commit' }[];
export declare function mipTextCommits(
  mip: { repository: string; path: string; pullRequest: string },
  o?: { fetchImpl?: (url: string, init?: unknown) => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }> },
): Promise<string[]>;
