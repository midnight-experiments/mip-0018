// SPDX-License-Identifier: Apache-2.0
//
// JSON-over-HTTP with a timeout, bounded retries and a minimum interval between requests.
//
// The interval is the politeness bound against public endpoints (Stagenet's indexer and RPC are shared services):
// every request made through one client waits until `minIntervalMs` has passed since the previous one started.
// Retries cover network errors, HTTP 408/429/5xx; a `Retry-After` header is honoured (capped).

export interface HttpOptions {
  /** Minimum milliseconds between the starts of two requests (0 = no bound). */
  minIntervalMs?: number;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Total attempts per request (1 = no retry). */
  attempts?: number;
  /** Upper bound on one backoff sleep. */
  maxBackoffMs?: number;
  /** Injected for tests. */
  fetch?: typeof fetch;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export class HttpError extends Error {
  override name = 'HttpError';
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class HttpClient {
  readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly attempts: number;
  private readonly maxBackoffMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private gate: Promise<void> = Promise.resolve();
  private lastStart = 0;
  /** Requests started (for politeness reports). */
  requests = 0;

  constructor(opts: HttpOptions = {}) {
    this.minIntervalMs = opts.minIntervalMs ?? 0;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.attempts = Math.max(1, opts.attempts ?? 4);
    this.maxBackoffMs = opts.maxBackoffMs ?? 10_000;
    this.fetchImpl = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? realSleep;
  }

  /** Waits for this client's turn (serialises request starts at `minIntervalMs`). */
  private async turn(): Promise<void> {
    const prev = this.gate;
    let release!: () => void;
    this.gate = new Promise<void>((r) => (release = r));
    await prev;
    const wait = this.lastStart + this.minIntervalMs - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.lastStart = Date.now();
    this.requests++;
    release();
  }

  /** POSTs JSON and parses a JSON response. Retries transient failures; throws `HttpError` otherwise. */
  async postJson<T>(url: string, body: unknown): Promise<T> {
    let last: unknown;
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      await this.turn();
      let retryAfterMs: number | undefined;
      try {
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (RETRY_STATUS.has(res.status)) {
          const ra = Number(res.headers.get('retry-after'));
          if (Number.isFinite(ra) && ra > 0) retryAfterMs = Math.min(ra * 1000, 60_000);
          throw new HttpError(`HTTP ${res.status} from ${url}`, res.status);
        }
        if (!res.ok) throw Object.assign(new HttpError(`HTTP ${res.status} from ${url}`, res.status), { final: true });
        return (await res.json()) as T;
      } catch (e) {
        last = e;
        if ((e as { final?: boolean }).final) throw e;
        if (attempt === this.attempts) break;
        const backoff = Math.min(this.maxBackoffMs, 500 * 2 ** (attempt - 1));
        await this.sleep(Math.max(backoff, retryAfterMs ?? 0));
      }
    }
    throw last instanceof Error ? last : new HttpError(String(last));
  }

  /** GET returning text (proof server `/version`, `/health`). */
  async getText(url: string): Promise<{ status: number; text: string }> {
    await this.turn();
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    return { status: res.status, text: (await res.text()).trim() };
  }
}
