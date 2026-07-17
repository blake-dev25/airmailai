import { ANTHROPIC } from './anthropic';
import { GOOGLE } from './google';
import { OPENAI } from './openai';
import { OPENROUTER } from './openrouter';
import { MODEL_TIERS } from './tiers';
import type {
    ModelOption,
    ModelTier,
    ModelTools,
    ProviderOption,
} from './types';

export { buildOpenRouterProvider } from './openrouter';
export { MODEL_TIERS } from './tiers';
export type {
    ModelOption,
    ModelParams,
    ModelTier,
    ProviderOption,
    ThinkingLevel,
} from './types';

// Google/OpenAI version their server tools globally, not per-model (unlike
// Anthropic's dated tool variants), so we attach a provider-wide default here
// rather than in the generated model files. `true` = versionless; the ext uses
// the provider's default tool factory.
const GOOGLE_TOOLS: ModelTools = {
    webSearch: true,
    webFetch: true,
    codeExecution: true,
};
const OPENAI_TOOLS: ModelTools = {
    webSearch: true,
    webFetch: true,
    codeExecution: true,
    // OpenAI funnels search + fetch through one web_search server tool.
    searchFetchLinked: true,
};

// `{ tools, ...m }` so any future per-model override in the data file wins.
function withDefaultTools(
    provider: ProviderOption,
    tools: ModelTools
): ProviderOption {
    return {
        ...provider,
        models: provider.models.map((m) => ({ tools, ...m })),
    };
}

// OpenRouter ships with an empty model list and is hydrated at runtime by the
// extension. Until that resolves, the Models config shows a loading state.
export const PROVIDERS: ProviderOption[] = [
    { ...ANTHROPIC, sandboxFileAttach: true },
    { ...withDefaultTools(OPENAI, OPENAI_TOOLS), sandboxFileAttach: true },
    { ...withDefaultTools(GOOGLE, GOOGLE_TOOLS), sandboxFileAttach: false },
    OPENROUTER,
].sort((a, b) => a.name.localeCompare(b.name));

const TIER_RANK: Record<ModelTier, number> = {
    latest: 0,
    previous: 1,
    legacy: 2,
};

export function modelMatchesTier(
    modelId: string,
    selected: ModelTier
): boolean {
    const modelTier = MODEL_TIERS[modelId] ?? 'legacy';
    return TIER_RANK[modelTier] <= TIER_RANK[selected];
}

// The model picker displays models grouped by tier (latest -> previous ->
// legacy), so "the top of the list" is the first model of the best tier
// present, not models[0] of the raw catalog order.
export function defaultModelForProvider(
    provider: ProviderOption
): ModelOption | undefined {
    if (provider.marketplace) return provider.models[0];
    let best: { model: ModelOption; rank: number } | undefined;
    for (const m of provider.models) {
        const rank = TIER_RANK[MODEL_TIERS[m.id] ?? 'legacy'];
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
            // Marketplace providers (OpenRouter) bypass tier curation -
            // their catalogs are too large and churn too fast to curate by hand.
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
