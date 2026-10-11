import { AnthropicProvider } from '@ai-commons/provider-anthropic';
import { OllamaProvider } from '@ai-commons/provider-ollama';
import { OpenAIProvider } from '@ai-commons/provider-openai';
import { secretAccounts } from '../secrets.js';
import { ProviderRegistry } from './registry.js';

const OLLAMA_DEFAULT_ENDPOINT = 'http://localhost:11434';

export function builtinProviders(): ProviderRegistry {
  return new ProviderRegistry()
    .register({
      id: 'ollama',
      kind: 'local',
      displayName: 'Ollama (local)',
      requiresKey: false,
      defaultEndpoint: OLLAMA_DEFAULT_ENDPOINT,
      factory: async (cfg) =>
        new OllamaProvider({ baseUrl: cfg.endpoint ?? OLLAMA_DEFAULT_ENDPOINT }),
    })
    .register({
      id: 'openai',
      kind: 'remote',
      displayName: 'OpenAI API',
      requiresKey: true,
      factory: async (cfg, secrets) => {
        const apiKey = await secrets.get(secretAccounts.provider(cfg.id));
        if (!apiKey) throw new Error(`No API key stored; run "aicommons set-key ${cfg.id}"`);
        return new OpenAIProvider({
          apiKey,
          pricing: cfg.pricing ?? {},
          ...(cfg.endpoint === undefined ? {} : { baseUrl: cfg.endpoint }),
        });
      },
    })
    .register({
      id: 'anthropic',
      kind: 'remote',
      displayName: 'Anthropic Claude API',
      requiresKey: true,
      factory: async (cfg, secrets) => {
        const apiKey = await secrets.get(secretAccounts.provider(cfg.id));
        if (!apiKey) throw new Error(`No API key stored; run "aicommons set-key ${cfg.id}"`);
        return new AnthropicProvider({
          apiKey,
          pricing: cfg.pricing ?? {},
          ...(cfg.endpoint === undefined ? {} : { baseUrl: cfg.endpoint }),
        });
      },
    });
}
