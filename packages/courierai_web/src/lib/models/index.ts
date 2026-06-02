import { ANTHROPIC } from './anthropic';
import { GOOGLE } from './google';
import { OPENAI } from './openai';
import { OPENROUTER } from './openrouter';
import { MODEL_TIERS } from './tiers';
import type { ModelTier, ModelTools, ProviderOption } from './types';

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
    ANTHROPIC,
    withDefaultTools(OPENAI, OPENAI_TOOLS),
    withDefaultTools(GOOGLE, GOOGLE_TOOLS),
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
