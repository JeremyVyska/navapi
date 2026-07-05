import { type BcRecord, companyLabel, findCompany, NavApiError } from '@navapi/core';
import type { Command } from 'commander';
import pc from 'picocolors';
import { createClient, profileStore } from '../context.js';
import { emitJson, printTable, wantJson } from '../output.js';
import { ask } from '../prompt.js';

async function pickInteractively(companies: BcRecord[]): Promise<BcRecord> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new NavApiError(
      'Company name required when not running interactively: navapi company use <name>',
    );
  }
  companies.forEach((c, i) => {
    console.log(
      `${pc.bold(String(i + 1).padStart(2))}) ${companyLabel(c)} ${pc.dim(String(c.name ?? ''))}`,
    );
  });
  const answer = await ask(`Select company [1-${companies.length}]: `);
  const index = Number.parseInt(answer, 10);
  const picked = companies[index - 1];
  if (!picked) throw new NavApiError(`No company at position "${answer}".`);
  return picked;
}

export function registerCompany(program: Command): void {
  const company = program
    .command('company')
    .description("List companies and switch the profile's default company");

  company
    .command('list')
    .description('List companies in the environment (● marks the profile default)')
    .option('--json', 'JSON output')
    .action(async (opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const client = await createClient(globals.profile);
      const companies = await client.listCompanies();
      if (wantJson(opts.json)) {
        emitJson(companies);
        return;
      }
      const current = client.profile.company
        ? findCompany(companies, client.profile.company)
        : undefined;
      printTable(
        companies.map((c) => ({
          '': c.id === current?.id ? '●' : '',
          name: c.name,
          displayName: c.displayName,
          id: c.id,
        })),
        ['', 'name', 'displayName', 'id'],
      );
    });

  company
    .command('use [name]')
    .description(
      'Set the default company for the profile (interactive picker when name is omitted)',
    )
    .option('--json', 'JSON output')
    .action(async (name: string | undefined, opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const client = await createClient(globals.profile);
      const companies = await client.listCompanies();

      let target: BcRecord | undefined;
      if (name) {
        target = findCompany(companies, name);
        if (!target) {
          throw new NavApiError(
            `Company "${name}" not found. Available: ${companies.map(companyLabel).join(', ')}`,
          );
        }
      } else {
        target = await pickInteractively(companies);
      }

      const store = profileStore();
      const profile = await store.get(client.profile.name);
      await store.upsert({ ...profile, company: companyLabel(target) });

      if (wantJson(opts.json)) {
        emitJson({ profile: profile.name, company: companyLabel(target), companyId: target.id });
        return;
      }
      console.log(
        `${pc.green('✔')} Profile ${pc.bold(profile.name)} now uses company ${pc.bold(
          companyLabel(target),
        )} ${pc.dim(String(target.id))}`,
      );
    });
}
