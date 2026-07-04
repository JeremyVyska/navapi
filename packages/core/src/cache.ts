import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CachedRouteMetadata, RouteMetadata } from './types.js';

function sanitize(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

export function defaultConfigDir(): string {
  return process.env.NAVAPI_CONFIG_DIR ?? path.join(os.homedir(), '.navapi');
}

/**
 * On-disk cache of parsed $metadata, one file per profile × route. This is
 * what makes the "collection tree" (route → entity sets) browsable offline.
 */
export class MetadataCache {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(defaultConfigDir(), 'cache');
  }

  private profileDir(profile: string): string {
    return path.join(this.baseDir, sanitize(profile));
  }

  private fileFor(profile: string, routePath: string): string {
    return path.join(this.profileDir(profile), `${sanitize(routePath)}.json`);
  }

  async get(profile: string, routePath: string): Promise<CachedRouteMetadata | undefined> {
    try {
      const raw = await readFile(this.fileFor(profile, routePath), 'utf8');
      return JSON.parse(raw) as CachedRouteMetadata;
    } catch {
      return undefined;
    }
  }

  async set(
    profile: string,
    routePath: string,
    metadata: RouteMetadata,
  ): Promise<CachedRouteMetadata> {
    const entry: CachedRouteMetadata = {
      routePath,
      fetchedAt: new Date().toISOString(),
      metadata,
    };
    await mkdir(this.profileDir(profile), { recursive: true });
    await writeFile(this.fileFor(profile, routePath), JSON.stringify(entry, null, 2), 'utf8');
    return entry;
  }

  /** All cached routes for a profile, sorted by route path. */
  async list(profile: string): Promise<CachedRouteMetadata[]> {
    let files: string[];
    try {
      files = await readdir(this.profileDir(profile));
    } catch {
      return [];
    }
    const entries: CachedRouteMetadata[] = [];
    for (const file of files.filter((f) => f.endsWith('.json'))) {
      try {
        const raw = await readFile(path.join(this.profileDir(profile), file), 'utf8');
        entries.push(JSON.parse(raw) as CachedRouteMetadata);
      } catch {
        // skip unreadable entries
      }
    }
    entries.sort((a, b) => a.routePath.localeCompare(b.routePath));
    return entries;
  }

  async clear(profile: string): Promise<void> {
    await rm(this.profileDir(profile), { recursive: true, force: true });
  }
}
