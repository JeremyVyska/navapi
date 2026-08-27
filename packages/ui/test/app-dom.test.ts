// @vitest-environment node
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderAppHtml } from '../src/app.js';

let dom: JSDOM | undefined;

afterEach(() => {
  dom?.window.close();
  dom = undefined;
});

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError;
}

describe('browser application DOM behavior', () => {
  it('renders profile and record data as text while authenticating every API call', async () => {
    const calls: { path: string; authorization?: string; body?: string }[] = [];
    const malicious = '<img src=x onerror="globalThis.pwned=true">';
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const requestPath = String(input);
      calls.push({
        path: requestPath,
        authorization: new Headers(init?.headers).get('authorization') ?? undefined,
        body: typeof init?.body === 'string' ? init.body : undefined,
      });
      if (requestPath === '/api/state') {
        return Response.json({
          profiles: [
            {
              name: malicious,
              tenantId: 'tenant',
              clientId: 'client',
              environment: 'Sandbox',
              company: 'CRONUS',
              hasSecret: true,
            },
            {
              name: 'stored-default',
              tenantId: 'tenant',
              clientId: 'client',
              environment: 'Production',
              hasSecret: true,
            },
          ],
          defaultProfile: 'stored-default',
        });
      }
      if (requestPath.startsWith('/api/companies')) {
        return Response.json({ companies: [] });
      }
      if (requestPath.startsWith('/api/discovery')) {
        return Response.json({
          routes: [
            {
              routePath: 'v2.0',
              metadata: {
                namespace: 'Microsoft.NAV',
                entitySets: [
                  {
                    name: 'customers',
                    entityType: 'Microsoft.NAV.customer',
                    keys: ['id'],
                    properties: [
                      { name: 'id', type: 'Edm.Guid', nullable: false },
                      { name: 'displayName', type: 'Edm.String', nullable: true },
                    ],
                    navigationProperties: [],
                    actions: [],
                  },
                ],
              },
            },
          ],
          errors: [],
        });
      }
      if (requestPath === '/api/query') {
        return Response.json({
          records: [{ id: 'id-1', displayName: malicious, expanded: [{ value: 1 }] }],
          grid: {
            columns: ['displayName', 'id', 'expanded'],
            rows: [
              [
                { kind: 'text', text: malicious },
                { kind: 'text', text: 'id-1' },
                {
                  kind: 'array',
                  text: '1 item',
                  nested: {
                    columns: ['value'],
                    rows: [[{ kind: 'text', text: '1' }]],
                  },
                },
              ],
            ],
          },
          totalCount: 1,
          queryUrl: 'https://bc.test/customers',
        });
      }
      if (requestPath === '/api/heartbeat') return Response.json({ ok: true });
      return Response.json({ error: 'unexpected request' }, { status: 500 });
    });

    dom = new JSDOM(renderAppHtml('nonce', '0.1.0-test'), {
      url: `http://127.0.0.1:4321/?profile=${encodeURIComponent(malicious)}#session-token`,
      runScripts: 'dangerously',
      beforeParse(window) {
        Object.defineProperty(window, 'fetch', { value: fetchMock });
      },
    });

    await waitFor(() => {
      expect(dom?.window.document.querySelector('#profiles .item')?.textContent).toContain(
        malicious,
      );
      expect(dom?.window.document.querySelector('#profiles .item.active')?.textContent).toContain(
        malicious,
      );
      expect(dom?.window.document.querySelector('#companiesProfile')?.textContent).toBe(malicious);
      expect(dom?.window.document.querySelector('#endpointsProfile')?.textContent).toBe(malicious);
      expect(
        dom?.window.document.querySelector('#companiesProfile')?.parentElement?.className,
      ).toBe('section-heading');
      expect(
        dom?.window.document.querySelector('#endpointsProfile')?.parentElement?.className,
      ).toBe('section-heading');
      expect(dom?.window.document.querySelectorAll('img')).toHaveLength(0);
      expect(dom?.window.location.hash).toBe('');
      expect(dom?.window.sessionStorage.getItem('navapi.sessionToken')).toBe('session-token');
    });
    const sidebarStyle = dom.window.getComputedStyle(
      dom.window.document.querySelector('.side-scroll') as HTMLElement,
    );
    expect(sidebarStyle.overflow).toBe('hidden');
    const sectionToggles = dom.window.document.querySelectorAll('.section-toggle');
    expect(sectionToggles).toHaveLength(3);
    expect([...sectionToggles].map((toggle) => toggle.textContent)).toEqual([
      'Profiles',
      'Companies',
      'Endpoint Browser',
    ]);
    for (const [index, bodyId] of ['profiles', 'companies', 'endpoints'].entries()) {
      const body = dom.window.document.querySelector(`#${bodyId}`) as HTMLElement;
      expect(dom.window.getComputedStyle(body).overflow).toBe('auto');
      (sectionToggles[index] as HTMLButtonElement).click();
      expect(sectionToggles[index].getAttribute('aria-expanded')).toBe('false');
      expect(body.hidden).toBe(true);
      expect(sectionToggles[index].closest('.section')?.classList.contains('collapsed')).toBe(true);
      for (const [otherIndex, otherBodyId] of ['profiles', 'companies', 'endpoints'].entries()) {
        if (otherIndex !== index) {
          expect((dom.window.document.querySelector(`#${otherBodyId}`) as HTMLElement).hidden).toBe(
            false,
          );
        }
      }
      (sectionToggles[index] as HTMLButtonElement).click();
      expect(body.hidden).toBe(false);
    }

    const routeToggle = dom.window.document.querySelector(
      '#endpoints .route-toggle',
    ) as HTMLButtonElement;
    const routeChildren = dom.window.document.querySelector(
      '#endpoints .route-children',
    ) as HTMLElement;
    expect(routeToggle.getAttribute('aria-expanded')).toBe('false');
    expect(routeToggle.textContent).toContain('1 entity sets');
    expect(routeChildren.hidden).toBe(true);
    expect(routeToggle.querySelector('.tree-icon')?.classList.contains('codicon-plug')).toBe(true);
    routeToggle.click();
    expect(routeToggle.getAttribute('aria-expanded')).toBe('true');
    expect(routeChildren.hidden).toBe(false);
    expect(
      routeChildren.querySelector('.entity .tree-icon')?.classList.contains('codicon-symbol-class'),
    ).toBe(true);

    (routeChildren.querySelector('.entity') as HTMLButtonElement).dispatchEvent(
      new dom.window.MouseEvent('click', { bubbles: true }),
    );

    await waitFor(() => {
      expect(dom?.window.document.querySelector('#grid td')?.textContent).toBe(malicious);
      expect(dom?.window.document.querySelectorAll('img')).toHaveLength(0);
    });
    const queryPanel = dom.window.document.querySelector('.query') as HTMLElement;
    expect(queryPanel.classList.contains('open')).toBe(false);
    (dom.window.document.querySelector('#queryToggle') as HTMLButtonElement).click();
    expect(queryPanel.classList.contains('open')).toBe(true);
    expect(dom.window.document.querySelectorAll('#filterRows .query-row')).toHaveLength(1);
    const filterField = dom.window.document.querySelector(
      '#filterRows select',
    ) as HTMLSelectElement;
    filterField.value = 'displayName';
    filterField.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    const filterValue = dom.window.document.querySelector('#filterRows input') as HTMLInputElement;
    filterValue.value = "O'Brien";
    filterValue.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect((dom.window.document.querySelector('#filterExpression') as HTMLInputElement).value).toBe(
      "contains(displayName,'O''Brien')",
    );
    expect((dom.window.document.querySelector('#queryUrl') as HTMLInputElement).value).toBe(
      'https://bc.test/customers',
    );
    (dom.window.document.querySelector('.query button.primary') as HTMLButtonElement).click();
    await waitFor(() => {
      const lastQuery = [...calls].reverse().find((call) => call.path === '/api/query');
      expect(lastQuery?.body).toBeTruthy();
      expect(JSON.parse(lastQuery?.body ?? '{}').orderby).toBeUndefined();
    });
    const queryCalls = calls.filter((call) => call.path === '/api/query').length;
    const expandedHeader = [...dom.window.document.querySelectorAll('#grid th')].find(
      (header) => header.textContent === 'expanded',
    ) as HTMLElement;
    expandedHeader.click();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls.filter((call) => call.path === '/api/query')).toHaveLength(queryCalls);
    expect(expandedHeader.classList.contains('nonsort')).toBe(true);
    expect(calls.length).toBeGreaterThan(3);
    expect(calls.every((call) => call.authorization === 'Bearer session-token')).toBe(true);
  });
});
