import type { CustomModelConfig, ProviderId } from '@airmailai/shared';
import type { ModelTools } from './types';

export const CUSTOM_PROVIDER_TOOLS: Record<ProviderId, ModelTools> = {
    anthropic: { webSearch: true, webFetch: true, codeExecution: true },
    google: { webSearch: true, webFetch: true, codeExecution: true },
    openai: { webSearch: true, codeExecution: true },
    openrouter: { webSearch: true, webFetch: true, codeExecution: true },
};

export function customModelTools(
    provider: ProviderId,
    config: CustomModelConfig
): ModelTools {
    const supported = CUSTOM_PROVIDER_TOOLS[provider];
    const tools: ModelTools = {};
    for (const key of ['webSearch', 'webFetch', 'codeExecution'] as const) {
        if (!supported[key]) continue;
        const value = config[key];
        if (provider === 'anthropic') {
            if (typeof value === 'string' && value.trim()) tools[key] = value;
        } else if (value === true) {
            tools[key] = true;
        }
    }
    return tools;
}
