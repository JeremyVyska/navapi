// @vitest-environment jsdom
/**
 * Runs the profile form's real script in a DOM, so the identity dropdown's
 * defaulting is tested where it actually lives rather than described in prose.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderFormHtml } from '../src/profile-form-html.js';

const posted: any[] = [];

// Each mount runs another copy of the form's script, which registers its own
// window-level message listener. jsdom keeps one window per file, so the
// previous copy would keep answering into the new DOM — unhook them first.
const addListener = window.addEventListener.bind(window);
let unhook: Array<() => void> = [];

function trackListeners(): void {
  for (const off of unhook) off();
  unhook = [];
  (window as any).addEventListener = (type: string, fn: any, opts?: any) => {
    unhook.push(() => window.removeEventListener(type, fn, opts));
    addListener(type, fn, opts);
  };
}

function mountForm(overrides: { mode?: 'add' | 'edit'; azAccount?: string } = {}): void {
  posted.length = 0;
  trackListeners();
  (window as any).acquireVsCodeApi = () => ({
    postMessage: (msg: unknown) => posted.push(msg),
  });
  const html = renderFormHtml(
    {
      mode: overrides.mode ?? 'add',
      hasStoredSecret: false,
      values: {
        name: 'contoso',
        tenantId: 't1',
        authType: 'azureCli',
        clientId: '',
        clientSecret: '',
        azAccount: overrides.azAccount ?? '',
        environment: 'Production',
        company: '',
        baseUrl: '',
      },
    },
    'TESTNONCE',
  );
  document.documentElement.innerHTML = html.replace(/^<!DOCTYPE html>\s*/i, '');
  const script = /<script nonce="TESTNONCE">([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!script) throw new Error('profile form script not found');
  new Function(script)(); // executes the form's own script under test
  (window as any).addEventListener = addListener;
}

function deliverIdentities(...users: { user: string; current?: boolean }[]): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: {
        type: 'azAccountsResult',
        ok: true,
        identities: users.map((u) => ({ user: u.user, current: Boolean(u.current) })),
      },
    }),
  );
}

const select = () => document.getElementById('azAccount') as HTMLSelectElement;

describe('profile form — az identity dropdown', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = '';
  });

  afterEach(() => {
    for (const off of unhook) off();
    unhook = [];
  });

  it('asks for the az identities as soon as azureCli auth is showing', () => {
    mountForm();
    expect(posted).toContainEqual({ type: 'azAccounts' });
  });

  it('pins the only identity on a new profile', () => {
    mountForm();
    deliverIdentities({ user: 'me@example.com', current: true });
    expect(select().value).toBe('me@example.com');
  });

  it('leaves the choice open when az reports several', () => {
    mountForm();
    deliverIdentities({ user: 'a@x.com', current: true }, { user: 'b@y.com' });
    expect(select().value).toBe('');
  });

  it('offers not pinning as an explicit option', () => {
    mountForm();
    deliverIdentities({ user: 'me@example.com' });
    const optOut = Array.from(select().options).find((o) => o.value === '');
    expect(optOut?.textContent).toMatch(/do not pin/i);
  });

  it('keeps an existing profile unpinned — that was somebody’s decision', () => {
    mountForm({ mode: 'edit' });
    deliverIdentities({ user: 'me@example.com', current: true });
    expect(select().value).toBe('');
  });

  it('keeps the saved identity when editing', () => {
    mountForm({ mode: 'edit', azAccount: 'pinned@example.com' });
    deliverIdentities({ user: 'pinned@example.com', current: true });
    expect(select().value).toBe('pinned@example.com');
  });

  it('does not re-pin after the user has chosen to follow az', () => {
    mountForm();
    deliverIdentities({ user: 'a@x.com' }, { user: 'b@y.com' });
    select().value = '';
    select().dispatchEvent(new Event('change'));
    deliverIdentities({ user: 'a@x.com' }); // b@y.com signed out in the meantime
    expect(select().value).toBe('');
  });
});
