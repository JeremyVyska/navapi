/** Tiny scripted fetch mock: match by method + URL predicate, in order of registration. */

export interface MockRoute {
  method?: string;
  match: string | RegExp | ((url: string) => boolean);
  /** Response body: object → JSON, string → text/xml. */
  body?: unknown;
  status?: number;
  headers?: Record<string, string>;
  /** Limit how many times this route may answer. */
  times?: number;
}

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export function mockFetch(routes: MockRoute[]) {
  const calls: RecordedCall[] = [];
  const remaining = routes.map((r) => ({ ...r, left: r.times ?? Number.POSITIVE_INFINITY }));

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    calls.push({ method, url, headers, body: init?.body as string | undefined });

    for (const route of remaining) {
      if (route.left <= 0) continue;
      if (route.method && route.method.toUpperCase() !== method) continue;
      const m = route.match;
      const hit =
        typeof m === 'string' ? url.includes(m) : m instanceof RegExp ? m.test(url) : m(url);
      if (!hit) continue;
      route.left--;
      const isText = typeof route.body === 'string';
      return new Response(
        route.body === undefined
          ? null
          : isText
            ? (route.body as string)
            : JSON.stringify(route.body),
        {
          status: route.status ?? 200,
          headers: {
            'content-type': isText ? 'application/xml' : 'application/json',
            ...route.headers,
          },
        },
      );
    }
    throw new Error(`mockFetch: unmatched request ${method} ${url}`);
  }) as typeof globalThis.fetch;

  return { fetchImpl, calls };
}
