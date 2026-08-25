import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

/** The BC API's OAuth resource (the scope without its `/.default` suffix). */
export const DEFAULT_RESOURCE = 'https://api.businesscentral.dynamics.com';

export const DEFAULT_SCOPE = `${DEFAULT_RESOURCE}/.default`;

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

/** Result of running the `az` CLI. */
export interface AzExecResult {
  stdout: string;
  stderr: string;
}

/** Runs `az` with the given arguments. Injectable so tests never shell out. */
export type AzExec = (file: string, args: string[]) => Promise<AzExecResult>;

export interface AzureCliAuthOptions {
  tenantId: string;
  /**
   * Which az account to authenticate as, given as a username or an account
   * id. Only needed when az holds more than one identity; by default az uses
   * whichever account it is currently signed in as.
   */
  account?: string;
  /** OAuth resource. Defaults to the BC API resource. */
  resource?: string;
  /** Path to the az executable. Defaults to `az`, resolved via PATH. */
  azPath?: string;
  /** Override the process runner; for tests. */
  exec?: AzExec;
}

/** One entry of `az account list --all`. */
interface AzAccount {
  id?: string;
  tenantId?: string;
  name?: string;
  user?: { name?: string };
}

/** Tenant IDs are GUIDs or domain names — anything else is not ours to pass on. */
const TENANT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESOURCE_PATTERN = /^https:\/\/[A-Za-z0-9][A-Za-z0-9._\-/]*$/;
/** Account ids come back from az as GUIDs. */
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9-]+$/;

/** How long to trust a token whose expiry az reported in a form we can't parse. */
const UNPARSABLE_EXPIRY_MS = 300_000;

/**
 * `az` on Windows is a batch file, which Node refuses to spawn without a shell.
 * Arguments are therefore validated against the patterns above rather than
 * quoted — nothing that reaches the command line can carry shell syntax.
 */
const NEEDS_SHELL = process.platform === 'win32';

const execFileAsync = promisify(execFile);

const defaultExec: AzExec = async (file, args) =>
  await execFileAsync(file, args, { shell: NEEDS_SHELL, windowsHide: true });

/**
 * Delegated auth using the identity the az CLI is already signed in with, via
 * `az account get-access-token`. No app registration and no stored secret —
 * the caller acts as themselves, with their own BC permissions.
 */
export class AzureCliAuth implements TokenProvider {
  private readonly tenantId: string;
  private readonly account?: string;
  private readonly resource: string;
  private readonly azPath: string;
  private readonly exec: AzExec;
  private cached?: { token: string; expiresAt: number };
  private accountId?: string;
  private inflight?: Promise<string>;

  constructor(options: AzureCliAuthOptions) {
    this.tenantId = options.tenantId;
    this.account = options.account;
    this.resource = options.resource ?? DEFAULT_RESOURCE;
    this.azPath = options.azPath ?? 'az';
    this.exec = options.exec ?? defaultExec;
    if (!TENANT_PATTERN.test(this.tenantId)) {
      throw new AuthError(`Invalid tenant ID or domain for Azure CLI auth: ${this.tenantId}`);
    }
    if (!RESOURCE_PATTERN.test(this.resource)) {
      throw new AuthError(`Invalid resource URL for Azure CLI auth: ${this.resource}`);
    }
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

  /**
   * The command that gets az into a state where we can ask it for a token.
   * `--allow-no-subscriptions` matters: a customer tenant that only has BC
   * usually has no Azure subscription at all, and az refuses to sign in
   * without it.
   */
  private get loginHint(): string {
    return `az login --tenant ${this.tenantId} --allow-no-subscriptions --scope ${this.resource}/.default`;
  }

  /**
   * Which account az should authenticate as. az takes the identity from its
   * active account, not from `--tenant`, so selecting a specific one means
   * passing `--subscription` — which az refuses to combine with `--tenant`.
   * The id always comes from az's own output, never from user input.
   */
  private async resolveAccountSelector(): Promise<string[]> {
    if (!this.account) return ['--tenant', this.tenantId];
    if (this.accountId) return ['--subscription', this.accountId];

    let stdout: string;
    try {
      ({ stdout } = await this.exec(this.azPath, ['account', 'list', '--all', '-o', 'json']));
    } catch (cause) {
      throw this.describeFailure(cause);
    }
    let accounts: AzAccount[];
    try {
      accounts = JSON.parse(stdout);
    } catch (cause) {
      throw new AuthError('Could not parse the JSON output of az account list', { cause });
    }

    const wanted = this.account.toLowerCase();
    const inTenant = accounts.filter(
      (a) => (a.tenantId ?? '').toLowerCase() === this.tenantId.toLowerCase(),
    );
    const match = inTenant.find(
      (a) => (a.id ?? '').toLowerCase() === wanted || (a.user?.name ?? '').toLowerCase() === wanted,
    );
    if (!match?.id) throw this.noSuchAccount(accounts);
    if (!ACCOUNT_ID_PATTERN.test(match.id)) {
      throw new AuthError(`az returned an unusable account id: ${match.id}`);
    }
    this.accountId = match.id;
    return ['--subscription', match.id];
  }

  /** Says which accounts az does have, so the fix doesn't need guesswork. */
  private noSuchAccount(accounts: AzAccount[]): AuthError {
    const known = accounts
      .map((a) => `${a.user?.name ?? '?'} (tenant ${a.tenantId ?? '?'})`)
      .join(', ');
    return new AuthError(
      `az has no account for "${this.account}" in tenant ${this.tenantId}. ` +
        (known ? `az is signed in as: ${known}. ` : 'az is not signed in to any account. ') +
        `Sign that identity in for this tenant: ${this.loginHint}`,
    );
  }

  private async requestToken(): Promise<string> {
    const selector = await this.resolveAccountSelector();
    let stdout: string;
    try {
      // --resource, not --scope: the v1-style form works on every az version
      // we might meet, while --scope needs a recent one. Same token either way.
      //
      // -o json, not -o tsv: tsv omits the expiry, which would cost a
      // subprocess per request instead of one per token lifetime.
      ({ stdout } = await this.exec(this.azPath, [
        'account',
        'get-access-token',
        '--resource',
        this.resource,
        ...selector,
        '-o',
        'json',
      ]));
    } catch (cause) {
      throw this.describeFailure(cause);
    }

    let json: { accessToken?: string; expiresOn?: string; expires_on?: number };
    try {
      json = JSON.parse(stdout);
    } catch (cause) {
      throw new AuthError('Could not parse the JSON output of az account get-access-token', {
        cause,
      });
    }
    if (!json.accessToken) {
      throw new AuthError('az account get-access-token returned no accessToken');
    }
    this.cached = { token: json.accessToken, expiresAt: parseExpiry(json) };
    return json.accessToken;
  }

  /** Turns az's exit codes and stderr into something the user can act on. */
  private describeFailure(cause: unknown): AuthError {
    const err = cause as { code?: string | number; stderr?: string };
    const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : '';
    if (err?.code === 'ENOENT' || /not (?:found|recognized)/i.test(stderr)) {
      return new AuthError(
        'az CLI not found on PATH. Install the Azure CLI, or use client-credentials auth ' +
          '(navapi profile add <name> --client-id <id> ...).',
        { cause },
      );
    }
    if (/AADSTS700082|refresh token (?:has )?expired/i.test(stderr)) {
      return new AuthError(
        `The az refresh token for tenant ${this.tenantId} has expired. Run: ${this.loginHint}`,
        { cause },
      );
    }
    if (/AADSTS50020/.test(stderr)) {
      // az picks the identity from its active account, not from --tenant, so
      // this is what a second identity looks like rather than a missing one.
      return new AuthError(
        `The account az is currently signed in as does not exist in tenant ${this.tenantId}. ` +
          `If another identity has access, sign it in for this tenant: ${this.loginHint}`,
        { cause },
      );
    }
    if (/az login/i.test(stderr)) {
      return new AuthError(`Not signed in to az. Run: ${this.loginHint}`, { cause });
    }
    const detail = stderr || (cause instanceof Error ? cause.message : String(cause));
    return new AuthError(`az account get-access-token failed: ${detail}`, { cause });
  }
}

/**
 * az reports the expiry twice: `expires_on` as epoch seconds (newer versions),
 * `expiresOn` as a local datetime string. Neither is guaranteed to be present.
 */
function parseExpiry(json: { expiresOn?: string; expires_on?: number }): number {
  if (typeof json.expires_on === 'number' && Number.isFinite(json.expires_on)) {
    return json.expires_on * 1000;
  }
  if (json.expiresOn) {
    const parsed = new Date(json.expiresOn).getTime();
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now() + UNPARSABLE_EXPIRY_MS;
}

/** Fixed-token provider, useful for tests or externally managed tokens. */
export class StaticTokenProvider implements TokenProvider {
  constructor(private readonly token: string) {}
  getToken(): Promise<string> {
    return Promise.resolve(this.token);
  }
}
