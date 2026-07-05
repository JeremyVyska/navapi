import { createRequire } from 'node:module';
import { HttpError, NavApiError } from '@navapi/core';
import { Command } from 'commander';
import pc from 'picocolors';
import { registerAction } from './commands/action.js';
import { registerCompany } from './commands/company.js';
import { registerCrud } from './commands/crud.js';
import { registerDiscover } from './commands/discover.js';
import { registerProfile } from './commands/profile.js';
import { registerSecrets } from './commands/secrets.js';

const program = new Command();

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

program
  .name('navapi')
  .description('The Business Central API toolkit that doesn’t make you cry. 🧭')
  .version(version)
  .option('-p, --profile <name>', 'Profile to use (default: NAVAPI_PROFILE or stored default)');

registerProfile(program);
registerDiscover(program);
registerCrud(program);
registerAction(program);
registerCompany(program);
registerSecrets(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  if (err instanceof HttpError) {
    console.error(pc.red(`error: ${err.message}${err.code ? pc.dim(` [${err.code}]`) : ''}`));
  } else if (err instanceof NavApiError) {
    console.error(pc.red(`error: ${err.message}`));
  } else {
    console.error(pc.red(`unexpected error: ${err instanceof Error ? err.stack : String(err)}`));
  }
  process.exit(1);
});
