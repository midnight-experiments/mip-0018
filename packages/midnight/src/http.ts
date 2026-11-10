// SPDX-License-Identifier: Apache-2.0
//
// JSON-over-HTTP with a timeout, bounded retries and a minimum interval between requests.
//
// The interval is the politeness bound against public endpoints (shared services, and per-plan request limits on
// Blockfrost): every request made through one client waits until `minIntervalMs` has passed since the previous one
// started. Retries cover network errors, HTTP 408/425/5xx and 429. A 429 pauses the WHOLE client — every request
// through it waits — for the back-off (doubling per attempt, at least the interval, a `Retry-After` header honoured
// up to 60 s), so a rate-limited endpoint sees no request until the pause is over. 401/403 are final: with an
// `authHint` (a profile that sends a Blockfrost token) they become a `TokenError` that names where the token came
// from. Error messages carry the URL without its query string, and every error is a `ScrubbedError` (redact.ts): a
// failure text that echoes the token or a token-bearing URL is scrubbed when the error is built.

import { redactUrl, ScrubbedError } from './redact.ts';

export interface HttpOptions {
  /** Minimum milliseconds between the starts of two requests (0 = no bound). */
  minIntervalMs?: number;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Total attempts per request (1 = no retry). */
  attempts?: number;
  /** Upper bound on one backoff sleep. */
  maxBackoffMs?: number;
  /** Added to the message of a 401/403 (which then is a `TokenError`): what to fix. */
  authHint?: string;
  /** Injected for tests. */
  fetch?: typeof fetch;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export class HttpError extends ScrubbedError {
  override name = 'HttpError';
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/** The endpoint refused the access token (HTTP 401/403 from a profile that sends one). */
export class TokenError extends HttpError {
  override name = 'TokenError';
}

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A failed request's message: the redacted URL and the error (with its cause, e.g. ECONNREFUSED). */
const failureText = (url: string, e: unknown): string => {
  const err = e as { message?: string; cause?: { message?: string; code?: string } };
  const cause = err.cause ? ` (${err.cause.code ?? err.cause.message ?? 'cause unknown'})` : '';
  return `request to ${redactUrl(url)} failed: ${err.message ?? String(e)}${cause}`;
};

export class HttpClient {
  readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly attempts: number;
  private readonly maxBackoffMs: number;
  private readonly authHint: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private gate: Promise<void> = Promise.resolve();
  private lastStart = 0;
  /** No request starts before this time (set by a 429 back-off). */
  private pausedUntil = 0;
  /** Requests started (for politeness reports). */
  requests = 0;
  /** HTTP 429 answers received (for politeness reports). */
  rateLimited = 0;

  constructor(opts: HttpOptions = {}) {
    this.minIntervalMs = opts.minIntervalMs ?? 0;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.attempts = Math.max(1, opts.attempts ?? 4);
    this.maxBackoffMs = opts.maxBackoffMs ?? 10_000;
    this.authHint = opts.authHint;
    this.fetchImpl = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? realSleep;
  }

  /** Waits for this client's turn (serialises request starts at `minIntervalMs`, after any 429 pause). */
  private async turn(): Promise<void> {
    const prev = this.gate;
    let release!: () => void;
    this.gate = new Promise<void>((r) => (release = r));
    await prev;
    const wait = Math.max(this.lastStart + this.minIntervalMs, this.pausedUntil) - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.lastStart = Date.now();
    this.requests++;
    release();
  }

  /** POSTs JSON and parses a JSON response. Retries transient failures; throws `HttpError` (or `TokenError`) otherwise. */
  async postJson<T>(url: string, body: unknown): Promise<T> {
    let last: unknown;
    let lastStatus: number | undefined;
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      await this.turn();
      let retryAfterMs: number | undefined;
      lastStatus = undefined;
      try {
        let res: Response;
        try {
          res = await this.fetchImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(this.timeoutMs),
          });
        } catch (e) {
          throw new HttpError(failureText(url, e));
        }
        lastStatus = res.status;
        if (RETRY_STATUS.has(res.status)) {
          const ra = Number(res.headers.get('retry-after'));
          if (Number.isFinite(ra) && ra > 0) retryAfterMs = Math.min(ra * 1000, 60_000);
          if (res.status === 429) this.rateLimited++;
          throw new HttpError(`HTTP ${res.status} from ${redactUrl(url)}`, res.status);
        }
        if ((res.status === 401 || res.status === 403) && this.authHint !== undefined)
          throw Object.assign(new TokenError(`HTTP ${res.status} from ${redactUrl(url)}: ${this.authHint}`, res.status), { final: true });
        if (!res.ok) throw Object.assign(new HttpError(`HTTP ${res.status} from ${redactUrl(url)}`, res.status), { final: true });
        try {
          return (await res.json()) as T;
        } catch (e) {
          throw Object.assign(new HttpError(failureText(url, e), res.status), { final: true });
        }
      } catch (e) {
        last = e;
        if ((e as { final?: boolean }).final) throw e;
        if (attempt === this.attempts) break;
        const backoff = Math.min(this.maxBackoffMs, 500 * 2 ** (attempt - 1));
        const pause = Math.max(backoff, retryAfterMs ?? 0, this.minIntervalMs);
        if (lastStatus === 429) this.pausedUntil = Math.max(this.pausedUntil, Date.now() + pause);
        else await this.sleep(pause);
      }
    }
    if (lastStatus === 429)
      throw new HttpError(
        `HTTP 429 from ${redactUrl(url)}: rate limited on all ${this.attempts} attempts (the endpoint's request limit; retry later or raise --min-interval-ms)`,
        429,
      );
    throw last instanceof HttpError ? last : new HttpError(failureText(url, last));
  }

  /** GET returning text (proof server `/version`, `/health`). */
  async getText(url: string): Promise<{ status: number; text: string }> {
    await this.turn();
    try {
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs) });
      return { status: res.status, text: (await res.text()).trim() };
    } catch (e) {
      throw new HttpError(failureText(url, e));
    }
  }
}
