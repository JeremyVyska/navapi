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
      /Not signed in to az\. Run: az login --tenant tenant-1 --scope https:\/\/api\.businesscentral\.dynamics\.com\/\.default/,
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
