import {
  type BcClient,
  type ClientSelector,
  createClientForSelector,
  defaultConfigDir,
  ProfileStore,
  type ResolvedSecretStore,
  resolveSecretStore,
} from '@navapi/core';
import type { Command } from 'commander';

export type { ClientSelector };

export function configDir(): string {
  return defaultConfigDir();
}

export function profileStore(): ProfileStore {
  return new ProfileStore(configDir());
}

/** Keychain when available, file otherwise (NAVAPI_SECRET_BACKEND overrides). */
export function secretStore(): Promise<ResolvedSecretStore> {
  return resolveSecretStore(configDir());
}

/**
 * Builds a client from the global flags. The resolution rule lives in core so
 * the CLI, MCP server, and extension all answer `--tenant` the same way.
 */
export function createClient(selector: ClientSelector | string = {}): Promise<BcClient> {
  return createClientForSelector(typeof selector === 'string' ? { profile: selector } : selector);
}

/**
 * Adds the per-command target overrides to a data command.
 *
 * Deliberately **not** global options: `navapi profile add` has its own
 * `--tenant`, `--environment`, and `--credential`, and a root-level flag of the
 * same name shadows the subcommand's, which silently breaks the most common
 * command in the tool. So they live on the commands that actually reach a BC
 * environment.
 */
export function withTargetOptions<T extends Command>(command: T): T {
  return command
    .option(
      '--credential <name>',
      'Credential to authenticate with, overriding the profile (env: NAVAPI_CREDENTIAL)',
    )
    .option('--tenant <tenantId>', 'Tenant to target, overriding the profile (env: NAVAPI_TENANT)')
    .option(
      '--environment <environment>',
      'Environment to target, overriding the profile (env: NAVAPI_ENVIRONMENT)',
    ) as T;
}
