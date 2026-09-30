import { FIRST_PARTY_PROVIDER_IDS } from './modelsFile';
import { OPENROUTER } from './openrouter';
import { modelHasTier, visibleModelTier } from './tiers';
import type {
    FirstPartyProviderId,
    ModelOption,
    ModelTierFilter,
    ModelTools,
    ModelsFile,
    ProviderMeta,
    ProviderOption,
    VisibleModelTier,
} from './types';

export { buildOpenRouterProvider, OPENROUTER } from './openrouter';
export { MODEL_TIERS, modelHasTier, visibleModelTier } from './tiers';
export { MODELS_FILE_PATH, parseModelsFile } from './modelsFile';
export type {
    FirstPartyProviderId,
    ModelOption,
    ModelParams,
    ModelsFile,
    ModelTier,
    ModelTierAssignment,
    ModelTierFilter,
    ProviderMeta,
    ProviderOption,
    ThinkingLevel,
    VisibleModelTier,
} from './types';

const GOOGLE_TOOLS: ModelTools = {
    webSearch: true,
    webFetch: true,
    codeExecution: true,
};
const OPENAI_TOOLS: ModelTools = {
    webSearch: true,
    webFetch: true,
    codeExecution: true,
    searchFetchLinked: true,
};

interface FirstPartyProviderConfig {
    name: string;
    sandboxFileAttach: boolean;
    defaultTools?: ModelTools;
}

const FIRST_PARTY: Record<FirstPartyProviderId, FirstPartyProviderConfig> = {
    anthropic: { name: 'Anthropic', sandboxFileAttach: true },
    openai: {
        name: 'OpenAI',
        sandboxFileAttach: true,
        defaultTools: OPENAI_TOOLS,
    },
    google: {
        name: 'Google',
        sandboxFileAttach: false,
        defaultTools: GOOGLE_TOOLS,
    },
};

function compareProviderNames(a: ProviderMeta, b: ProviderMeta): number {
    return a.name.localeCompare(b.name);
}

export const PROVIDER_META: readonly ProviderMeta[] = [
    ...FIRST_PARTY_PROVIDER_IDS.map((id): ProviderMeta => ({
        id,
        name: FIRST_PARTY[id].name,
        sandboxFileAttach: FIRST_PARTY[id].sandboxFileAttach,
    })),
    { id: OPENROUTER.id, name: OPENROUTER.name, marketplace: true },
].sort(compareProviderNames);

export function buildFirstPartyProviders(file: ModelsFile): ProviderOption[] {
    return FIRST_PARTY_PROVIDER_IDS.map((id) => {
        const config = FIRST_PARTY[id];
        const models = config.defaultTools
            ? file.providers[id].map((m) => ({
                  tools: config.defaultTools,
                  ...m,
              }))
            : file.providers[id];
        return {
            id,
            name: config.name,
            sandboxFileAttach: config.sandboxFileAttach,
            models,
        };
    });
}

export function sortProviders(providers: ProviderOption[]): ProviderOption[] {
    return [...providers].sort(compareProviderNames);
}

const FILTER_RANK: Record<VisibleModelTier, number> = {
    new: 0,
    latest: 1,
    previous: 2,
    legacy: 3,
};

const DEFAULT_RANK: Record<VisibleModelTier, number> = {
    latest: 0,
    new: 1,
    previous: 2,
    legacy: 3,
};

export function modelMatchesTier(
    modelId: string,
    selected: ModelTierFilter
): boolean {
    if (selected === 'test') return modelHasTier(modelId, selected);
    const modelTier = visibleModelTier(modelId);
    return FILTER_RANK[modelTier] <= FILTER_RANK[selected];
}

export function defaultModelForProvider(
    provider: ProviderOption
): ModelOption | undefined {
    if (provider.marketplace) return provider.models[0];
    let best: { model: ModelOption; rank: number } | undefined;
    for (const m of provider.models) {
        const rank = DEFAULT_RANK[visibleModelTier(m.id)];
        if (!best || rank < best.rank) best = { model: m, rank };
    }
    return best?.model;
}

export function filterProvidersByTier(
    providers: ProviderOption[],
    selected: ModelTierFilter
): ProviderOption[] {
    return providers
        .map((p) => {
            if (p.marketplace) return p;
            return {
                ...p,
                models: p.models.filter((m) =>
                    modelMatchesTier(m.id, selected)
                ),
            };
        })
        .filter((p) => p.marketplace || p.models.length > 0);
}
