import type { CustomModelConfig } from '@airmailai/shared';
import type { ModelTools } from './types';

export const CUSTOM_PROVIDER_TOOLS: Record<string, ModelTools> = {
    anthropic: { webSearch: true, webFetch: true, codeExecution: true },
    google: { webSearch: true, webFetch: true, codeExecution: true },
    openai: { webSearch: true, codeExecution: true },
    openrouter: { webSearch: true, webFetch: true },
};

export function customModelTools(
    provider: string,
    config: CustomModelConfig
): ModelTools {
    const supported = CUSTOM_PROVIDER_TOOLS[provider];
    const tools: ModelTools = {};
    for (const key of ['webSearch', 'webFetch', 'codeExecution'] as const) {
        if (!supported?.[key]) continue;
        const value = config[key];
        if (provider === 'anthropic') {
            if (typeof value === 'string' && value.trim()) tools[key] = value;
        } else if (value === true) {
            tools[key] = true;
        }
    }
    return tools;
}
