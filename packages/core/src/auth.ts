import { AuthError } from './errors.js';

export interface TokenProvider {
  getToken(): Promise<string>;
}

export interface ClientCredentialsOptions {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** OAuth scope. Defaults to the BC API's `.default` scope. */
  scope?: string;
  /** Authority host. Defaults to https://login.microsoftonline.com */
  authorityBase?: string;
  fetch?: typeof globalThis.fetch;
}

export const DEFAULT_SCOPE = 'https://api.businesscentral.dynamics.com/.default';

/** Refresh the token this many ms before it actually expires. */
const EXPIRY_SKEW_MS = 120_000;

/**
 * OAuth 2.0 client-credentials flow against Entra ID, with in-memory token
 * caching and automatic refresh shortly before expiry.
 */
export class ClientCredentialsAuth implements TokenProvider {
  private readonly opts: Required<Omit<ClientCredentialsOptions, 'fetch'>>;
  private readonly fetchImpl: typeof globalThis.fetch;
  private cached?: { token: string; expiresAt: number };
  private inflight?: Promise<string>;

  constructor(options: ClientCredentialsOptions) {
    this.opts = {
      tenantId: options.tenantId,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      scope: options.scope ?? DEFAULT_SCOPE,
      authorityBase: options.authorityBase ?? 'https://login.microsoftonline.com',
    };
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async getToken(): Promise<string> {
    if (this.cached && Date.now() < this.cached.expiresAt - EXPIRY_SKEW_MS) {
      return this.cached.token;
    }
    this.inflight ??= this.requestToken().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async requestToken(): Promise<string> {
    const url = `${this.opts.authorityBase}/${this.opts.tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret,
      scope: this.opts.scope,
    });
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (cause) {
      throw new AuthError(`Could not reach token endpoint ${url}`, { cause });
    }
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 500);
      try {
        const json = JSON.parse(text) as { error?: string; error_description?: string };
        detail = json.error_description ?? json.error ?? detail;
      } catch {
        // keep raw text
      }
      throw new AuthError(`Token request failed (HTTP ${res.status}): ${detail}`);
    }
    const json = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!json.access_token) {
      throw new AuthError('Token endpoint returned no access_token');
    }
    this.cached = {
      token: json.access_token,
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    };
    return json.access_token;
  }
}

/** Fixed-token provider, useful for tests or externally managed tokens. */
export class StaticTokenProvider implements TokenProvider {
  constructor(private readonly token: string) {}
  getToken(): Promise<string> {
    return Promise.resolve(this.token);
  }
}
