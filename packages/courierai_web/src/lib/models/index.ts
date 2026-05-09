import { ANTHROPIC } from './anthropic';
import { GOOGLE } from './google';
import { OPENAI } from './openai';
import { OPENROUTER } from './openrouter';
import { MODEL_TIERS } from './tiers';
import type { ModelTier, ProviderOption } from './types';

export { buildOpenRouterProvider } from './openrouter';
export { MODEL_TIERS } from './tiers';
export type {
    ModelOption,
    ModelParams,
    ModelTier,
    ProviderOption,
    ThinkingLevel,
} from './types';

// OpenRouter ships with an empty model list and is hydrated at runtime by the
// extension. Until that resolves, the Models config shows a loading state.
export const PROVIDERS: ProviderOption[] = [
    ANTHROPIC,
    OPENAI,
    GOOGLE,
    OPENROUTER,
];

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
            // Marketplace providers (OpenRouter) bypass tier curation —
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
