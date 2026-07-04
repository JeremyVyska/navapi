import type { TokenProvider } from './auth.js';
import { NavApiError, toHttpError } from './errors.js';

export interface BcHttpOptions {
  auth: TokenProvider;
  fetch?: typeof globalThis.fetch;
  /** Max retries for 429/502/503/504 responses. Default 3. */
  maxRetries?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  /** JSON-serializable body, or a pre-serialized string. */
  body?: unknown;
  ifMatch?: string;
}

export interface BcResponse {
  status: number;
  headers: Headers;
  /** Parsed JSON body when the response is JSON, otherwise undefined. */
  data: unknown;
  /** Raw body text (e.g. $metadata XML). */
  text: string;
}

const RETRYABLE = new Set([429, 502, 503, 504]);
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(res: Response, attempt: number): number {
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  }
  const backoff = BACKOFF_BASE_MS * 2 ** attempt;
  return Math.min(backoff + Math.random() * BACKOFF_BASE_MS, BACKOFF_CAP_MS);
}

/**
 * Authenticated fetch wrapper: bearer tokens, JSON handling, throttling
 * retries with Retry-After/backoff, and OData error surfacing.
 */
export class BcHttp {
  private readonly auth: TokenProvider;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: BcHttpOptions) {
    this.auth = options.auth;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.maxRetries = options.maxRetries ?? 3;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async request(method: string, url: string, options: RequestOptions = {}): Promise<BcResponse> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.auth.getToken();
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...options.headers,
      };
      if (options.ifMatch) headers['if-match'] = options.ifMatch;
      let body: string | undefined;
      if (options.body !== undefined) {
        headers['content-type'] ??= 'application/json';
        body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      }

      let res: Response;
      try {
        res = await this.fetchImpl(url, { method, headers, body });
      } catch (cause) {
        throw new NavApiError(`Request failed: ${method} ${url}`, { cause });
      }

      if (RETRYABLE.has(res.status) && attempt < this.maxRetries) {
        await this.sleep(retryDelayMs(res, attempt));
        continue;
      }

      const text = await res.text();
      let data: unknown;
      const contentType = res.headers.get('content-type') ?? '';
      if (text && contentType.includes('json')) {
        try {
          data = JSON.parse(text);
        } catch {
          // leave data undefined; caller can use text
        }
      }
      if (!res.ok) throw toHttpError(res.status, data ?? text);
      return { status: res.status, headers: res.headers, data, text };
    }
  }
}
