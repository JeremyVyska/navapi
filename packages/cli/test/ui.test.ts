import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { startUiServer } = vi.hoisted(() => ({ startUiServer: vi.fn() }));

vi.mock('@navapi/ui', () => ({ startUiServer }));

import { registerUi } from '../src/commands/ui.js';

beforeEach(() => {
  startUiServer.mockReset();
  startUiServer.mockResolvedValue({
    url: 'http://127.0.0.1:4321/#secret',
    port: 4321,
    token: 'secret',
    alreadyRunning: false,
    closed: Promise.resolve(),
    close: vi.fn(),
  });
});

describe('navapi ui command', () => {
  it('passes profile options and prints the authenticated URL only for --no-open', async () => {
    const program = new Command().exitOverride();
    program.option('-p, --profile <name>');
    registerUi(program);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await program.parseAsync([
      'node',
      'navapi',
      '--profile',
      'demo',
      'ui',
      '--no-open',
      '--json',
      '--idle-timeout',
      '15',
    ]);

    expect(startUiServer).toHaveBeenCalledWith({
      profile: 'demo',
      port: undefined,
      open: false,
      idleTimeoutMs: 15_000,
    });
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        url: 'http://127.0.0.1:4321/#secret',
        port: 4321,
        alreadyRunning: false,
      }),
    );
    expect(log.mock.calls.flat().join(' ')).toContain('secret');
    log.mockRestore();
  });
});
