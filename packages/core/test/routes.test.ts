import { describe, expect, it } from 'vitest';
import { parseRoutesResponse } from '../src/index.js';

describe('parseRoutesResponse', () => {
  it('parses { route } items', () => {
    const routes = parseRoutesResponse({
      value: [{ route: 'v2.0' }, { route: 'microsoft/automation/v2.0' }],
    });
    expect(routes).toEqual([
      { path: 'v2.0', version: 'v2.0' },
      {
        path: 'microsoft/automation/v2.0',
        publisher: 'microsoft',
        group: 'automation',
        version: 'v2.0',
      },
    ]);
  });

  it('parses { publisher, group, version } items', () => {
    const routes = parseRoutesResponse({
      value: [
        { publisher: 'contoso', group: 'fieldops', version: 'v1.0' },
        { publisher: '', group: '', version: 'v2.0' },
      ],
    });
    expect(routes).toEqual([
      { path: 'contoso/fieldops/v1.0', publisher: 'contoso', group: 'fieldops', version: 'v1.0' },
      { path: 'v2.0', publisher: undefined, group: undefined, version: 'v2.0' },
    ]);
  });

  it('parses plain string arrays and skips junk', () => {
    const routes = parseRoutesResponse({ value: ['v2.0', null, 42, {}] });
    expect(routes).toEqual([{ path: 'v2.0', version: 'v2.0' }]);
  });

  it('returns empty array for unrecognized payloads', () => {
    expect(parseRoutesResponse(undefined)).toEqual([]);
    expect(parseRoutesResponse({ value: 'nope' })).toEqual([]);
  });
});
