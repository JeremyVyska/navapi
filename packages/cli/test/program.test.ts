import { describe, expect, it } from 'vitest';
import { buildProgram } from '../src/program.js';

/**
 * The target overrides (`--credential`, `--tenant`, `--environment`) must live
 * on the data commands and *not* on the root program: `profile add` declares
 * its own options of those names, and a root-level flag shadows them, which
 * silently breaks the most common command in the tool. That failure only shows
 * up when the CLI actually parses, so it is pinned here.
 */
function optionNames(command: { options: { long?: string }[] }): string[] {
  return command.options.map((o) => o.long ?? '').filter(Boolean);
}

function find(path: string[]) {
  let current = buildProgram() as unknown as {
    name(): string;
    commands: { name(): string; commands: unknown[]; options: { long?: string }[] }[];
    options: { long?: string }[];
  };
  for (const segment of path) {
    const next = current.commands.find((c) => c.name() === segment);
    if (!next) throw new Error(`no such command: ${path.join(' ')}`);
    current = next as typeof current;
  }
  return current;
}

const TARGET_FLAGS = ['--credential', '--tenant', '--environment'];

describe('CLI option wiring', () => {
  it('keeps the target overrides off the root program', () => {
    const root = optionNames(buildProgram() as never);
    for (const flag of TARGET_FLAGS) expect(root).not.toContain(flag);
    expect(root).toContain('--profile');
  });

  it('leaves `profile add` owning its own --tenant, --environment, and --credential', () => {
    const add = find(['profile', 'add']);
    // Declared once each — a duplicate from the global pass would shadow these.
    for (const flag of TARGET_FLAGS) {
      expect(optionNames(add).filter((o) => o === flag)).toHaveLength(1);
    }
  });

  it('puts the target overrides on the commands that reach an environment', () => {
    for (const path of [['get'], ['post'], ['patch'], ['delete'], ['discover'], ['action']]) {
      const command = find(path);
      for (const flag of TARGET_FLAGS) {
        expect(optionNames(command), `${path.join(' ')} is missing ${flag}`).toContain(flag);
      }
    }
  });

  it('reaches nested data commands, including two levels down', () => {
    for (const path of [
      ['braider', 'get'],
      // `braider config ls` is two levels deep; a one-level walk missed it.
      ['braider', 'config', 'ls'],
    ]) {
      const command = find(path);
      for (const flag of TARGET_FLAGS) {
        expect(optionNames(command), `${path.join(' ')} is missing ${flag}`).toContain(flag);
      }
    }
  });

  it('leaves the config groups alone', () => {
    for (const path of [
      ['profile', 'list'],
      ['credential', 'list'],
      ['secrets', 'status'],
    ]) {
      const command = find(path);
      for (const flag of TARGET_FLAGS) {
        expect(optionNames(command), `${path.join(' ')} should not carry ${flag}`).not.toContain(
          flag,
        );
      }
    }
  });
});
