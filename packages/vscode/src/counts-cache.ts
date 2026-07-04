/**
 * Last-known record counts per profile (configDir/counts/*.json), keyed by
 * `route/entitySet`. Written whenever the records panel learns an unfiltered
 * $count; shown as a badge in the Endpoint Browser tree.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultConfigDir } from '@navapi/core';

export interface CountEntry {
  count: number;
  at: string;
}

function fileFor(profileName: string): string {
  const safe = profileName.replace(/[^a-zA-Z0-9._-]+/g, '_');
  return path.join(defaultConfigDir(), 'counts', `${safe}.json`);
}

export async function loadCounts(profileName: string): Promise<Record<string, CountEntry>> {
  try {
    const parsed = JSON.parse(await readFile(fileFor(profileName), 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, CountEntry>) : {};
  } catch {
    return {};
  }
}

export async function saveCount(
  profileName: string,
  routePath: string,
  entitySet: string,
  count: number,
): Promise<void> {
  const file = fileFor(profileName);
  const counts = await loadCounts(profileName);
  counts[`${routePath}/${entitySet}`] = { count, at: new Date().toISOString() };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(counts, null, 2), 'utf8');
}
