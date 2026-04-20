import * as fs from 'fs';
import * as path from 'path';
import {
  requestLlmCompletion,
  resolveLlmProvider,
  type LlmProvider,
  type LlmModelTier
} from '../llm-provider.js';

const VALID_PROVIDERS: LlmProvider[] = ['anthropic', 'openai', 'gemini', 'xai', 'openclaw'];
const VAULT_CONFIG_FILE = '.clawvault.json';

function asProvider(value: unknown): LlmProvider | null {
  if (typeof value !== 'string') {
    return null;
  }
  return VALID_PROVIDERS.includes(value as LlmProvider) ? value as LlmProvider : null;
}

export interface WorkerLlmClient {
  enabled: boolean;
  provider: LlmProvider | null;
  model: string | null;
  complete: (
    systemPrompt: string,
    userPrompt: string,
    options?: { tier?: LlmModelTier; model?: string }
  ) => Promise<string>;
}

function readWorkerLlmOverrides(vaultPath: string): { provider: LlmProvider | null; model: string | null } {
  try {
    const configPath = path.join(path.resolve(vaultPath), VAULT_CONFIG_FILE);
    if (!fs.existsSync(configPath)) {
      return { provider: null, model: null };
    }

    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { provider: null, model: null };
    }

    const observe = (parsed as Record<string, unknown>).observe;
    if (!observe || typeof observe !== 'object' || Array.isArray(observe)) {
      return { provider: null, model: null };
    }

    const record = observe as Record<string, unknown>;
    const provider = asProvider(record.provider);
    const model = typeof record.model === 'string' && record.model.trim()
      ? record.model.trim()
      : null;
    return { provider, model };
  } catch {
    return { provider: null, model: null };
  }
}

export function createWorkerLlmClient(vaultPath: string): WorkerLlmClient {
  if (process.env.CLAWVAULT_NO_LLM) {
    return {
      enabled: false,
      provider: null,
      model: null,
      complete: async () => ''
    };
  }

  const { provider: configuredProvider, model: configuredModel } = readWorkerLlmOverrides(vaultPath);

  const resolvedProvider = configuredProvider ?? resolveLlmProvider();
  const enabled = !!resolvedProvider;

  return {
    enabled,
    provider: resolvedProvider,
    model: configuredModel,
    complete: async (
      systemPrompt: string,
      userPrompt: string,
      options: { tier?: LlmModelTier; model?: string } = {}
    ): Promise<string> => {
      if (!enabled) {
        return '';
      }
      try {
        return await requestLlmCompletion({
          provider: resolvedProvider,
          model: options.model ?? configuredModel ?? undefined,
          tier: options.tier ?? 'default',
          systemPrompt,
          prompt: userPrompt,
          temperature: 0.1,
          maxTokens: 1200
        });
      } catch {
        return '';
      }
    }
  };
}
