/**
 * On-disk cache of each profile's company list (configDir/companies/*.json),
 * kept separate from the $metadata cache so route listings stay clean. Lets
 * the Companies tree section render offline; Discover and Refresh repopulate.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type BcRecord, defaultConfigDir } from '@navapi/core';

function fileFor(profileName: string): string {
  const safe = profileName.replace(/[^a-zA-Z0-9._-]+/g, '_');
  return path.join(defaultConfigDir(), 'companies', `${safe}.json`);
}

export async function loadCompanies(profileName: string): Promise<BcRecord[] | undefined> {
  try {
    const parsed = JSON.parse(await readFile(fileFor(profileName), 'utf8')) as BcRecord[];
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function saveCompanies(profileName: string, companies: BcRecord[]): Promise<void> {
  const file = fileFor(profileName);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(companies, null, 2), 'utf8');
}
