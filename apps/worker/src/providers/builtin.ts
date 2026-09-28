import { ProviderRegistry, type ProviderFactory } from './registry.js';

const notWired =
  (id: string): ProviderFactory =>
  async () => {
    throw new Error(`The ${id} adapter is not bundled with this build of the worker yet`);
  };

/** Adapters are wired here by replacing the `notWired` factories. */
export function builtinProviders(): ProviderRegistry {
  return new ProviderRegistry()
    .register({
      id: 'ollama',
      kind: 'local',
      displayName: 'Ollama (local)',
      requiresKey: false,
      defaultEndpoint: 'http://localhost:11434',
      factory: notWired('ollama'),
    })
    .register({
      id: 'openai',
      kind: 'remote',
      displayName: 'OpenAI API',
      requiresKey: true,
      factory: notWired('openai'),
    });
}
