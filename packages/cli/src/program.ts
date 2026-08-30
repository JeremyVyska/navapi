import { createRequire } from 'node:module';
import { Command } from 'commander';
import { registerAction } from './commands/action.js';
import { registerBraider } from './commands/braider.js';
import { registerCompany } from './commands/company.js';
import { registerCredential } from './commands/credential.js';
import { registerCrud } from './commands/crud.js';
import { registerDiscover } from './commands/discover.js';
import { registerProfile } from './commands/profile.js';
import { registerSecrets } from './commands/secrets.js';
import { registerUi } from './commands/ui.js';
import { withTargetOptions } from './context.js';

export function buildProgram(): Command {
  const program = new Command();

  const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

  program
    .name('navapi')
    .description('The Business Central API toolkit that doesn’t make you cry. 🧭')
    .version(version)
    .option('-p, --profile <name>', 'Profile to use (default: NAVAPI_PROFILE or stored default)');

  registerProfile(program);
  registerCredential(program);
  registerDiscover(program);
  registerCrud(program);
  registerAction(program);
  registerCompany(program);
  registerBraider(program);
  registerSecrets(program);
  registerUi(program);

  /**
   * The target overrides go on every command that reaches a BC environment.
   *
   * Not on the root: `profile add` and `credential add` declare their own
   * `--tenant`, `--environment`, and `--credential`, and a root-level flag of the
   * same name shadows the subcommand's — which silently breaks `profile add`.
   * Adding them here rather than command by command means a new data command
   * gets them without anyone remembering to.
   */
  const CONFIG_GROUPS = new Set(['profile', 'credential', 'secrets', 'ui', 'help']);
  // Recursive: `braider config ls` is two levels down, and a one-level walk
  // would quietly leave the whole config group without the overrides.
  const addToLeaves = (command: Command): void => {
    if (command.commands.length) {
      for (const child of command.commands) addToLeaves(child);
      return;
    }
    withTargetOptions(command);
  };
  for (const group of program.commands) {
    if (CONFIG_GROUPS.has(group.name())) continue;
    addToLeaves(group);
  }

  return program;
}
