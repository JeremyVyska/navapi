import { describe, expect, it } from 'vitest';
import { BcHttp, HttpError, StaticTokenProvider } from '../src/index.js';
import { mockFetch } from './helpers.js';

const noSleep = () => Promise.resolve();

describe('BcHttp', () => {
  it('sends bearer token and accept header', async () => {
    const { fetchImpl, calls } = mockFetch([{ match: '/ping', body: { ok: true } }]);
    const http = new BcHttp({ auth: new StaticTokenProvider('tok'), fetch: fetchImpl });

    const res = await http.request('GET', 'https://x.example/ping');
    expect(res.data).toEqual({ ok: true });
    expect(calls[0].headers.authorization).toBe('Bearer tok');
    expect(calls[0].headers.accept).toBe('application/json');
  });

  it('retries 429 honoring Retry-After, then succeeds', async () => {
    const { fetchImpl, calls } = mockFetch([
      { match: '/busy', status: 429, headers: { 'retry-after': '0' }, body: {}, times: 2 },
      { match: '/busy', body: { ok: true } },
    ]);
    const http = new BcHttp({
      auth: new StaticTokenProvider('tok'),
      fetch: fetchImpl,
      sleep: noSleep,
    });

    const res = await http.request('GET', 'https://x.example/busy');
    expect(res.data).toEqual({ ok: true });
    expect(calls).toHaveLength(3);
  });

  it('gives up after maxRetries and throws the OData error', async () => {
    const { fetchImpl, calls } = mockFetch([
      {
        match: '/down',
        status: 503,
        body: { error: { code: 'Unavailable', message: 'Service busy' } },
      },
    ]);
    const http = new BcHttp({
      auth: new StaticTokenProvider('tok'),
      fetch: fetchImpl,
      maxRetries: 2,
      sleep: noSleep,
    });

    const err = await http.request('GET', 'https://x.example/down').catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(503);
    expect(err.code).toBe('Unavailable');
    expect(err.message).toContain('Service busy');
    expect(calls).toHaveLength(3); // initial + 2 retries
  });

  it('does not retry 400-class errors', async () => {
    const { fetchImpl, calls } = mockFetch([
      { match: '/bad', status: 400, body: { error: { code: 'BadRequest', message: 'nope' } } },
    ]);
    const http = new BcHttp({
      auth: new StaticTokenProvider('tok'),
      fetch: fetchImpl,
      sleep: noSleep,
    });

    await expect(http.request('GET', 'https://x.example/bad')).rejects.toThrow(/nope/);
    expect(calls).toHaveLength(1);
  });

  it('returns raw text for XML responses', async () => {
    const { fetchImpl } = mockFetch([{ match: '/$metadata', body: '<edmx/>' }]);
    const http = new BcHttp({ auth: new StaticTokenProvider('tok'), fetch: fetchImpl });

    const res = await http.request('GET', 'https://x.example/$metadata');
    expect(res.text).toBe('<edmx/>');
    expect(res.data).toBeUndefined();
  });
});
