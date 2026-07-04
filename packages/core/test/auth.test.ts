import { describe, expect, it } from 'vitest';
import { AuthError, ClientCredentialsAuth } from '../src/index.js';
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
