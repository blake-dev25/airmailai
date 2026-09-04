import type { OpenRouterModel } from '@airmailai/shared';
import type { ModelOption, ProviderOption } from './types';

export const OPENROUTER: ProviderOption = {
    id: 'openrouter',
    name: 'OpenRouter',
    models: [],
    marketplace: true,
};

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
        tools: { webSearch: true, webFetch: true },
    };
}

// *** `~`-prefixed vendors are OpenRouter's premier-provider tag: a curated
// subset that lives as its own group alongside the same vendor's regular
// catalog. Premier groups sort first, alphabetical within each group. Plain
// localeCompare would push `~` (ASCII 126) to the bottom.
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
        models.sort(
            (a, b) => b.created - a.created || a.name.localeCompare(b.name)
        );
        for (const m of models) ordered.push(rawToOption(m));
    }
    return { ...OPENROUTER, models: ordered };
}
