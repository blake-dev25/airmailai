import type { OpenRouterModel } from '@airmailai/shared';
import type { ModelOption, ProviderOption } from './types';

// Skeleton - hydrated at runtime from the extension's OpenRouter cache.
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
        inputModalities: m.inputModalities,
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
        // OpenRouter server tools run model-agnostically; their docs say
        // "any model can call during a request". Code execution isn't offered.
        tools: { webSearch: true, webFetch: true },
    };
}

// `~`-prefixed vendors (OpenRouter's "premier provider" tag) sort to the top,
// alphabetical within both the pinned and non-pinned groups. ASCII `~` (126)
// would otherwise sort to the bottom under default localeCompare.
function compareVendors(a: string, b: string): number {
    const aPinned = a.startsWith('~');
    const bPinned = b.startsWith('~');
    if (aPinned !== bPinned) return aPinned ? -1 : 1;
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
        // Newest first; ties broken alphabetically by name.
        models.sort(
            (a, b) => b.created - a.created || a.name.localeCompare(b.name)
        );
        for (const m of models) ordered.push(rawToOption(m));
    }
    return { ...OPENROUTER, models: ordered };
}
