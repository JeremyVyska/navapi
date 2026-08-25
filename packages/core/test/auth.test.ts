import { describe, expect, it } from 'vitest';
import { AuthError, type AzExec, AzureCliAuth, ClientCredentialsAuth } from '../src/index.js';
import { mockFetch } from './helpers.js';

const OPTS = { tenantId: 'tenant-1', clientId: 'client-1', clientSecret: 's3cret' };

describe('ClientCredentialsAuth', () => {
  it('requests a token with the client-credentials grant and caches it', async () => {
    const { fetchImpl, calls } = mockFetch([
      {
        method: 'POST',
        match: '/tenant-1/oauth2/v2.0/token',
        body: { access_token: 'tok-1', expires_in: 3600 },
      },
    ]);
    const auth = new ClientCredentialsAuth({ ...OPTS, fetch: fetchImpl });

    expect(await auth.getToken()).toBe('tok-1');
    expect(await auth.getToken()).toBe('tok-1');
    expect(calls).toHaveLength(1);

    const params = new URLSearchParams(calls[0].body);
    expect(params.get('grant_type')).toBe('client_credentials');
    expect(params.get('client_id')).toBe('client-1');
    expect(params.get('scope')).toBe('https://api.businesscentral.dynamics.com/.default');
  });

  it('refreshes when the cached token is near expiry', async () => {
    const { fetchImpl, calls } = mockFetch([
      {
        method: 'POST',
        match: '/token',
        body: { access_token: 'tok-short', expires_in: 60 }, // < 120s skew → immediately stale
        times: 1,
      },
      {
        method: 'POST',
        match: '/token',
        body: { access_token: 'tok-fresh', expires_in: 3600 },
      },
    ]);
    const auth = new ClientCredentialsAuth({ ...OPTS, fetch: fetchImpl });

    expect(await auth.getToken()).toBe('tok-short');
    expect(await auth.getToken()).toBe('tok-fresh');
    expect(calls).toHaveLength(2);
  });

  it('coalesces concurrent token requests into one', async () => {
    const { fetchImpl, calls } = mockFetch([
      { method: 'POST', match: '/token', body: { access_token: 'tok', expires_in: 3600 } },
    ]);
    const auth = new ClientCredentialsAuth({ ...OPTS, fetch: fetchImpl });

    const [a, b] = await Promise.all([auth.getToken(), auth.getToken()]);
    expect(a).toBe('tok');
    expect(b).toBe('tok');
    expect(calls).toHaveLength(1);
  });

  it('surfaces Entra error descriptions', async () => {
    const { fetchImpl } = mockFetch([
      {
        method: 'POST',
        match: '/token',
        status: 401,
        body: { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid secret' },
      },
    ]);
    const auth = new ClientCredentialsAuth({ ...OPTS, fetch: fetchImpl });

    await expect(auth.getToken()).rejects.toThrow(AuthError);
    await expect(auth.getToken()).rejects.toThrow(/AADSTS7000215/);
  });
});

/** One canned az run: either output, or the error execFile would reject with. */
type AzRun = { stdout: string } | { error: unknown };

/** Records the az invocations and replays canned runs; the last one repeats. */
function mockAz(runs: AzRun[]): {
  exec: AzExec;
  calls: Array<{ file: string; args: string[] }>;
} {
  const calls: Array<{ file: string; args: string[] }> = [];
  const queue = [...runs];
  const exec: AzExec = async (file, args) => {
    calls.push({ file, args });
    const run = queue.length > 1 ? (queue.shift() as AzRun) : queue[0];
    if ('error' in run) throw run.error;
    return { stdout: run.stdout, stderr: '' };
  };
  return { exec, calls };
}

const azJson = (token: string, expiresInSeconds: number) => ({
  stdout: JSON.stringify({
    accessToken: token,
    expiresOn: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
    expires_on: Math.floor(Date.now() / 1000) + expiresInSeconds,
    tokenType: 'Bearer',
  }),
});

/** How execFile rejects: an Error carrying the exit code and captured stderr. */
const azFails = (stderr: string, code: string | number = 1) => ({
  error: Object.assign(new Error(`Command failed with ${code}`), { code, stderr }),
});

describe('AzureCliAuth', () => {
  it('asks az for a BC token and caches it', async () => {
    const { exec, calls } = mockAz([azJson('az-tok', 3600)]);
    const auth = new AzureCliAuth({ tenantId: 'contoso.onmicrosoft.com', exec });

    expect(await auth.getToken()).toBe('az-tok');
    expect(await auth.getToken()).toBe('az-tok');
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('az');
    expect(calls[0].args).toEqual([
      'account',
      'get-access-token',
      '--resource',
      'https://api.businesscentral.dynamics.com',
      '--tenant',
      'contoso.onmicrosoft.com',
      '-o',
      'json',
    ]);
  });

  it('refreshes when the cached token is near expiry', async () => {
    const { exec, calls } = mockAz([
      azJson('tok-short', 60), // < 120s skew → immediately stale
      azJson('tok-fresh', 3600),
    ]);
    const auth = new AzureCliAuth({ tenantId: 'tenant-1', exec });

    expect(await auth.getToken()).toBe('tok-short');
    expect(await auth.getToken()).toBe('tok-fresh');
    expect(calls).toHaveLength(2);
  });

  it('trusts an unparsable expiry for five minutes rather than failing', async () => {
    const { exec, calls } = mockAz([
      { stdout: JSON.stringify({ accessToken: 'tok', expiresOn: 'not a date' }) },
    ]);
    const auth = new AzureCliAuth({ tenantId: 'tenant-1', exec });

    expect(await auth.getToken()).toBe('tok');
    expect(await auth.getToken()).toBe('tok');
    expect(calls).toHaveLength(1);
  });

  it('coalesces concurrent token requests into one', async () => {
    const { exec, calls } = mockAz([azJson('tok', 3600)]);
    const auth = new AzureCliAuth({ tenantId: 'tenant-1', exec });

    const [a, b] = await Promise.all([auth.getToken(), auth.getToken()]);
    expect(a).toBe('tok');
    expect(b).toBe('tok');
    expect(calls).toHaveLength(1);
  });

  it('points at the alternative when az is not installed', async () => {
    const { exec } = mockAz([azFails('', 'ENOENT')]);
    const auth = new AzureCliAuth({ tenantId: 'tenant-1', exec });

    await expect(auth.getToken()).rejects.toThrow(AuthError);
    await expect(auth.getToken()).rejects.toThrow(/az CLI not found on PATH.*--client-id/s);
  });

  it('tells the user to sign in when az has no account', async () => {
    const { exec } = mockAz([azFails("Please run 'az login' to setup account.")]);
    const auth = new AzureCliAuth({ tenantId: 'tenant-1', exec });

    await expect(auth.getToken()).rejects.toThrow(
      /Not signed in to az\. Run: az login --tenant tenant-1 --allow-no-subscriptions --scope https:\/\/api\.businesscentral\.dynamics\.com\/\.default/,
    );
  });

  it('explains that az is signed in as a different identity', async () => {
    const { exec } = mockAz([
      azFails("AADSTS50020: User account '{EUII Hidden}' does not exist in tenant 'Contoso'."),
    ]);
    const auth = new AzureCliAuth({ tenantId: 'tenant-1', exec });

    await expect(auth.getToken()).rejects.toThrow(
      /does not exist in tenant tenant-1.*az login --tenant tenant-1 --allow-no-subscriptions/s,
    );
  });

  it('recognizes an expired refresh token', async () => {
    const { exec } = mockAz([
      azFails("AADSTS700082: The refresh token has expired due to inactivity. Run 'az login'."),
    ]);
    const auth = new AzureCliAuth({ tenantId: 'tenant-1', exec });

    await expect(auth.getToken()).rejects.toThrow(/refresh token for tenant tenant-1 has expired/);
  });

  it('surfaces any other az failure verbatim', async () => {
    const { exec } = mockAz([azFails('AADSTS50076: MFA required')]);
    const auth = new AzureCliAuth({ tenantId: 'tenant-1', exec });

    await expect(auth.getToken()).rejects.toThrow(/AADSTS50076: MFA required/);
  });

  it('refuses tenant IDs and resources that could carry shell syntax', () => {
    expect(() => new AzureCliAuth({ tenantId: 'tenant-1 && rm -rf /' })).toThrow(/Invalid tenant/);
    expect(
      () => new AzureCliAuth({ tenantId: 'tenant-1', resource: 'https://bc.example.com;whoami' }),
    ).toThrow(/Invalid resource/);
  });
});

const azAccounts = (accounts: Array<{ id: string; tenantId: string; user: string }>) => ({
  stdout: JSON.stringify(accounts.map((a) => ({ ...a, user: { name: a.user } }))),
});

const azActive = (user: string, tenantId: string, id = 'sub-active') => ({
  stdout: JSON.stringify({ id, tenantId, user: { name: user } }),
});

const NOT_SIGNED_IN = azFails("Please run 'az login' to setup account.");

const TWO_IDENTITIES = azAccounts([
  { id: 'sub-abc', tenantId: 'tenant-1', user: 'me@abc.com' },
  { id: 'sub-smc', tenantId: 'tenant-2', user: 'me@smc.com' },
]);

describe('AzureCliAuth account selection', () => {
  it('passes --tenant when no account is pinned', async () => {
    const { exec, calls } = mockAz([azJson('tok', 3600)]);
    await new AzureCliAuth({ tenantId: 'tenant-1', exec }).getToken();

    expect(calls[0].args).toContain('--tenant');
    expect(calls[0].args).not.toContain('--subscription');
  });

  it('resolves a username to that account id and passes --subscription', async () => {
    const { exec, calls } = mockAz([TWO_IDENTITIES, azJson('tok', 3600)]);
    const auth = new AzureCliAuth({ tenantId: 'tenant-2', account: 'me@smc.com', exec });

    expect(await auth.getToken()).toBe('tok');
    expect(calls[0].args).toEqual(['account', 'list', '--all', '-o', 'json']);
    // az rejects --tenant and --subscription together, so only one may appear.
    expect(calls[1].args).toContain('--subscription');
    expect(calls[1].args).toContain('sub-smc');
    expect(calls[1].args).not.toContain('--tenant');
  });

  it('accepts an account id directly', async () => {
    const { exec, calls } = mockAz([TWO_IDENTITIES, azJson('tok', 3600)]);
    await new AzureCliAuth({ tenantId: 'tenant-1', account: 'sub-abc', exec }).getToken();

    expect(calls[1].args).toContain('sub-abc');
  });

  it('looks the account up once and reuses it across refreshes', async () => {
    const { exec, calls } = mockAz([
      TWO_IDENTITIES,
      azJson('tok-short', 60), // stale on arrival, forcing a second token request
      azJson('tok-fresh', 3600),
    ]);
    const auth = new AzureCliAuth({ tenantId: 'tenant-1', account: 'me@abc.com', exec });

    expect(await auth.getToken()).toBe('tok-short');
    expect(await auth.getToken()).toBe('tok-fresh');
    expect(calls.filter((c) => c.args[1] === 'list')).toHaveLength(1);
  });

  it('uses --tenant when the pinned identity is the one az is signed in as', async () => {
    // Delegated admin (GDAP) and guest access reach a tenant az holds no
    // account in; only --tenant expresses that, and it uses the active identity.
    const { exec, calls } = mockAz([
      TWO_IDENTITIES,
      azActive('me@abc.com', 'tenant-1'),
      azJson('tok', 3600),
    ]);
    const auth = new AzureCliAuth({ tenantId: 'tenant-9', account: 'me@abc.com', exec });

    expect(await auth.getToken()).toBe('tok');
    expect(calls[2].args).toContain('--tenant');
    expect(calls[2].args).toContain('tenant-9');
    expect(calls[2].args).not.toContain('--subscription');
  });

  it('resolves the identity once and reuses it on the --tenant path too', async () => {
    const { exec, calls } = mockAz([
      TWO_IDENTITIES,
      azActive('me@abc.com', 'tenant-1'),
      azJson('tok-short', 60),
      azJson('tok-fresh', 3600),
    ]);
    const auth = new AzureCliAuth({ tenantId: 'tenant-9', account: 'me@abc.com', exec });

    expect(await auth.getToken()).toBe('tok-short');
    expect(await auth.getToken()).toBe('tok-fresh');
    expect(calls.filter((c) => c.args[1] === 'list' || c.args[1] === 'show')).toHaveLength(2);
  });

  it('refuses to authenticate as a different identity than the one pinned', async () => {
    // me@smc.com holds no account in tenant-1 and is not the active identity,
    // so --tenant would quietly authenticate as me@abc.com instead.
    const { exec } = mockAz([TWO_IDENTITIES, azActive('me@abc.com', 'tenant-1')]);
    const auth = new AzureCliAuth({ tenantId: 'tenant-1', account: 'me@smc.com', exec });

    await expect(auth.getToken()).rejects.toThrow(
      /cannot authenticate as "me@smc\.com" for tenant tenant-1.*that is me@abc\.com/s,
    );
  });

  it('lists the identities az does have when the pinned one is unknown', async () => {
    const { exec } = mockAz([TWO_IDENTITIES, azActive('me@abc.com', 'tenant-1')]);
    const auth = new AzureCliAuth({ tenantId: 'tenant-1', account: 'nobody@example.com', exec });

    await expect(auth.getToken()).rejects.toThrow(
      /az login --tenant tenant-1.*az knows: me@abc\.com, me@smc\.com/s,
    );
  });

  it('says az is signed out rather than blaming the pinned identity', async () => {
    const { exec } = mockAz([azAccounts([]), NOT_SIGNED_IN]);
    const auth = new AzureCliAuth({ tenantId: 'tenant-1', account: 'me@abc.com', exec });

    await expect(auth.getToken()).rejects.toThrow(/az is not signed in to any account/);
  });
});
