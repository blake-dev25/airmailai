import type { OpenRouterModel } from '@courier/shared';
import type { ModelOption, ProviderOption } from './types';

// First three vendors are pinned in this order; the rest go alphabetical.
// Newest model in each group floats to the top.
const PINNED_VENDORS = ['openai', 'anthropic', 'google'];

// Skeleton — hydrated at runtime from the extension's OpenRouter cache.
// Until hydration runs the picker shows an empty list under this provider.
export const OPENROUTER: ProviderOption = {
    id: 'openrouter',
    name: 'OpenRouter',
    models: [],
    marketplace: true,
};

// Reasoning effort isn't enumerated per-model in OpenRouter's catalog, so we
// expose the same vocabulary as Anthropic/OpenAI when the model declares
// reasoning support. Models that don't list it get no thinking slider.
const REASONING_LEVELS = ['none', 'low', 'medium', 'high', 'xhigh'] as const;

function rawToOption(m: OpenRouterModel): ModelOption {
    const supportsReasoning = m.supportedParams.includes('reasoning');
    const supportsTemperature = m.supportedParams.includes('temperature');
    return {
        id: m.id,
        name: m.name,
        vendor: m.vendor,
        params: {
            contextWindow: m.contextWindow,
            maxOutputTokens: m.maxOutputTokens,
            defaultMaxTokens: Math.min(8192, m.maxOutputTokens),
            ...(supportsTemperature
                ? { temperatureMax: 2, defaultTemperature: 1 }
                : {}),
            ...(supportsReasoning
                ? {
                      thinking: {
                          levels: [...REASONING_LEVELS],
                          defaultLevel: 'medium',
                      },
                  }
                : {}),
        },
    };
}

// Big-3 vendors first (in order), then alphabetical. Within each group:
// newest `created` first.
function compareVendors(a: string, b: string): number {
    const aIdx = PINNED_VENDORS.indexOf(a);
    const bIdx = PINNED_VENDORS.indexOf(b);
    if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
    if (aIdx !== -1) return -1;
    if (bIdx !== -1) return 1;
    return a.localeCompare(b);
}

export function buildOpenRouterProvider(
    raw: OpenRouterModel[]
): ProviderOption {
    const byVendor = new Map<string, OpenRouterModel[]>();
    for (const m of raw) {
        const list = byVendor.get(m.vendor);
        if (list) list.push(m);
        else byVendor.set(m.vendor, [m]);
    }
    const ordered: ModelOption[] = [];
    const vendors = Array.from(byVendor.keys()).sort(compareVendors);
    for (const v of vendors) {
        const models = byVendor.get(v)!;
        models.sort((a, b) => b.created - a.created);
        for (const m of models) ordered.push(rawToOption(m));
    }
    return { ...OPENROUTER, models: ordered };
}
