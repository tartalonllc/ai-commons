import type { ProviderKind } from '@ai-commons/protocol';
import type { AIProvider } from '@ai-commons/provider-core';
import type { ProviderConfig } from '../config.js';
import type { SecretStore } from '../secrets.js';

export type ProviderFactory = (cfg: ProviderConfig, secrets: SecretStore) => Promise<AIProvider>;

export interface ProviderRegistration {
  id: string;
  kind: ProviderKind;
  displayName: string;
  /** Remote providers need an API key from the keyring (`aicommons set-key <id>`). */
  requiresKey: boolean;
  defaultEndpoint?: string;
  factory: ProviderFactory;
}

export class ProviderRegistry {
  private readonly entries = new Map<string, ProviderRegistration>();

  register(registration: ProviderRegistration): this {
    this.entries.set(registration.id, registration);
    return this;
  }

  get(id: string): ProviderRegistration | undefined {
    return this.entries.get(id);
  }

  list(): ProviderRegistration[] {
    return [...this.entries.values()];
  }

  async create(cfg: ProviderConfig, secrets: SecretStore): Promise<AIProvider> {
    const entry = this.entries.get(cfg.id);
    if (!entry) throw new Error(`No adapter registered for provider "${cfg.id}"`);
    if (entry.kind !== cfg.kind) {
      throw new Error(`Provider "${cfg.id}" is ${entry.kind}, but config says ${cfg.kind}`);
    }
    const provider = await entry.factory(cfg, secrets);
    if (provider.kind !== entry.kind) {
      throw new Error(
        `Adapter for "${cfg.id}" reported kind ${provider.kind}, expected ${entry.kind}`,
      );
    }
    return provider;
  }
}
