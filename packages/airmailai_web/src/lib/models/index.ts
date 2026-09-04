import { ANTHROPIC } from './anthropic';
import { GOOGLE } from './google';
import { OPENAI } from './openai';
import { OPENROUTER } from './openrouter';
import { modelHasTier, visibleModelTier } from './tiers';
import type {
    ModelOption,
    ModelTier,
    ModelTools,
    ProviderOption,
    VisibleModelTier,
} from './types';

export { buildOpenRouterProvider } from './openrouter';
export { MODEL_TIERS, modelHasTier, visibleModelTier } from './tiers';
export type {
    ModelOption,
    ModelParams,
    ModelTier,
    ModelTierAssignment,
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

function withDefaultTools(
    provider: ProviderOption,
    tools: ModelTools
): ProviderOption {
    return {
        ...provider,
        models: provider.models.map((m) => ({ tools, ...m })),
    };
}

export const PROVIDERS: ProviderOption[] = [
    { ...ANTHROPIC, sandboxFileAttach: true },
    { ...withDefaultTools(OPENAI, OPENAI_TOOLS), sandboxFileAttach: true },
    { ...withDefaultTools(GOOGLE, GOOGLE_TOOLS), sandboxFileAttach: false },
    OPENROUTER,
].sort((a, b) => a.name.localeCompare(b.name));

const TIER_RANK: Record<VisibleModelTier, number> = {
    latest: 0,
    previous: 1,
    legacy: 2,
};

export function modelMatchesTier(
    modelId: string,
    selected: ModelTier
): boolean {
    if (selected === 'test') return modelHasTier(modelId, selected);
    const modelTier = visibleModelTier(modelId);
    return TIER_RANK[modelTier] <= TIER_RANK[selected];
}

export function defaultModelForProvider(
    provider: ProviderOption
): ModelOption | undefined {
    if (provider.marketplace) return provider.models[0];
    let best: { model: ModelOption; rank: number } | undefined;
    for (const m of provider.models) {
        const rank = TIER_RANK[visibleModelTier(m.id)];
        if (!best || rank < best.rank) best = { model: m, rank };
    }
    return best?.model;
}

export function filterProvidersByTier(
    providers: ProviderOption[],
    selected: ModelTier
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
