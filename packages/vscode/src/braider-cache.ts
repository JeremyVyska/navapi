/**
 * On-disk cache of each profile's Data Braider detection + endpoint list
 * (configDir/braider/*.json). Lets the Data Braider tree section render
 * offline; expanding with Refresh repopulates. Mirrors companies-cache.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type BraiderEndpoint,
  type BraiderInfo,
  defaultConfigDir,
  MetadataCache,
} from '@navapi/core';

export interface BraiderCacheEntry {
  fetchedAt: string;
  info: BraiderInfo;
  endpoints: BraiderEndpoint[];
}

function fileFor(profileName: string): string {
  const safe = profileName.replace(/[^a-zA-Z0-9._-]+/g, '_');
  return path.join(defaultConfigDir(), 'braider', `${safe}.json`);
}

export async function loadBraiderCache(
  profileName: string,
): Promise<BraiderCacheEntry | undefined> {
  try {
    const parsed = JSON.parse(await readFile(fileFor(profileName), 'utf8')) as BraiderCacheEntry;
    return parsed?.info && Array.isArray(parsed.endpoints) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function saveBraiderCache(
  profileName: string,
  info: BraiderInfo,
  endpoints: BraiderEndpoint[],
): Promise<void> {
  const file = fileFor(profileName);
  await mkdir(path.dirname(file), { recursive: true });
  const entry: BraiderCacheEntry = { fetchedAt: new Date().toISOString(), info, endpoints };
  await writeFile(file, JSON.stringify(entry, null, 2), 'utf8');
}

/**
 * Offline check whether the profile's cached $metadata contains a Data
 * Braider route — used to set the `navapi:braiderAvailable` context key
 * WITHOUT building a client (no secret access, no network on activation).
 */
export async function hasBraiderRouteCached(profileName: string): Promise<boolean> {
  const cached = await new MetadataCache(path.join(defaultConfigDir(), 'cache')).list(profileName);
  return cached.some((c) => c.routePath.toLowerCase().startsWith('sparebrained/databraider/'));
}
