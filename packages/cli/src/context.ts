import {
  type BcClient,
  createClientForProfile,
  defaultConfigDir,
  FileSecretStore,
  ProfileStore,
} from '@navapi/core';

export function configDir(): string {
  return defaultConfigDir();
}

export function profileStore(): ProfileStore {
  return new ProfileStore(configDir());
}

export function secretStore(): FileSecretStore {
  return new FileSecretStore(configDir());
}

/** Profile resolution: --profile flag → NAVAPI_PROFILE env → stored default. */
export function createClient(profileName?: string): Promise<BcClient> {
  return createClientForProfile(profileName);
}
