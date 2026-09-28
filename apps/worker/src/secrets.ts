import type * as Keyring from '@napi-rs/keyring';
import type { AsyncEntry } from '@napi-rs/keyring';

export const KEYRING_SERVICE = 'ai-commons';

export interface SecretStore {
  get(account: string): Promise<string | undefined>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<boolean>;
}

export class SecretStoreUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(
      'The operating system credential store is unavailable. AI Commons never stores ' +
        'credentials in plaintext, so it cannot continue. On Linux, install and unlock a ' +
        'Secret Service provider (e.g. gnome-keyring); on Windows and macOS, ensure Credential ' +
        'Manager / Keychain is accessible.',
      cause === undefined ? undefined : { cause },
    );
    this.name = 'SecretStoreUnavailableError';
  }
}

export const secretAccounts = {
  provider: (providerId: string) => `provider:${providerId}`,
  workerSecret: (coordinatorOrigin: string, workerId: string) =>
    `worker:${coordinatorOrigin}:${workerId}`,
};

/** Windows Credential Manager, macOS Keychain, or Linux Secret Service via @napi-rs/keyring. */
export class KeyringSecretStore implements SecretStore {
  private async entry(account: string): Promise<AsyncEntry> {
    let mod: typeof Keyring;
    try {
      mod = await import('@napi-rs/keyring');
    } catch (error) {
      throw new SecretStoreUnavailableError(error);
    }
    return new mod.AsyncEntry(KEYRING_SERVICE, account);
  }

  async get(account: string): Promise<string | undefined> {
    const entry = await this.entry(account);
    try {
      return (await entry.getPassword()) ?? undefined;
    } catch (error) {
      throw new SecretStoreUnavailableError(error);
    }
  }

  async set(account: string, secret: string): Promise<void> {
    const entry = await this.entry(account);
    try {
      await entry.setPassword(secret);
    } catch (error) {
      throw new SecretStoreUnavailableError(error);
    }
  }

  async delete(account: string): Promise<boolean> {
    const entry = await this.entry(account);
    try {
      return await entry.deleteCredential();
    } catch (error) {
      throw new SecretStoreUnavailableError(error);
    }
  }
}

export class MemorySecretStore implements SecretStore {
  readonly values = new Map<string, string>();

  async get(account: string): Promise<string | undefined> {
    return this.values.get(account);
  }

  async set(account: string, secret: string): Promise<void> {
    this.values.set(account, secret);
  }

  async delete(account: string): Promise<boolean> {
    return this.values.delete(account);
  }
}
