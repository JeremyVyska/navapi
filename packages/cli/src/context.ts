import {
  type BcClient,
  createClientForProfile,
  defaultConfigDir,
  ProfileStore,
  type ResolvedSecretStore,
  resolveSecretStore,
} from '@navapi/core';

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

/** Profile resolution: --profile flag → NAVAPI_PROFILE env → stored default. */
export function createClient(profileName?: string): Promise<BcClient> {
  return createClientForProfile(profileName);
}
