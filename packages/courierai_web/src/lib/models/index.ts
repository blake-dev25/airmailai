import { ANTHROPIC } from './anthropic';
import { GOOGLE } from './google';
import { OPENAI } from './openai';
import { MODEL_TIERS } from './tiers';
import type { ModelTier, ProviderOption } from './types';

export { MODEL_TIERS } from './tiers';
export type {
    ModelOption,
    ModelParams,
    ModelTier,
    ProviderOption,
    ThinkingLevel,
} from './types';

export const PROVIDERS: ProviderOption[] = [ANTHROPIC, OPENAI, GOOGLE];

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
        .map((p) => ({
            ...p,
            models: p.models.filter((m) => modelMatchesTier(m.id, selected)),
        }))
        .filter((p) => p.models.length > 0);
}
