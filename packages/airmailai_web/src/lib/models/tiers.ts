import type { ModelTier, ModelTierAssignment, VisibleModelTier } from './types';

// *** Manually curated. Unknown ids fall through to 'new', so a freshly
// released model surfaces under "New" the moment models.json lists it and
// stays there until it gets an explicit tier here.
// 'test' tier is used for playwright testing and not exposed in the UI.
export const MODEL_TIERS: Record<string, ModelTierAssignment> = {
    // *** anthropic
    'claude-fable-5': 'legacy',
    'claude-fable-5-1': 'legacy',
    'claude-fable-5-2': 'latest',
    'claude-haiku-4-5': 'legacy',
    'claude-haiku-5-5': 'latest',
    'claude-opus-4-5-20251101': 'legacy',
    'claude-opus-4-6': 'legacy',
    'claude-opus-4-7': 'legacy',
    'claude-opus-4-8': 'legacy',
    'claude-opus-5': 'legacy',
    'claude-opus-5-5': 'latest',
    'claude-sonnet-4-5-20250929': 'legacy',
    'claude-sonnet-4-6': 'legacy',
    'claude-sonnet-5': 'legacy',
    'claude-sonnet-5-5': ['latest', 'test'],
    // *** openai
    'gpt-4.1': 'legacy',
    'gpt-4.1-mini': 'legacy',
    'gpt-4o': 'legacy',
    'gpt-4o-mini': 'legacy',
    'gpt-5': 'legacy',
    'gpt-5-mini': 'legacy',
    'gpt-5-nano': 'legacy',
    'gpt-5-pro': 'legacy',
    'gpt-5.1': 'legacy',
    'gpt-5.2': 'legacy',
    'gpt-5.2-pro': 'legacy',
    'gpt-5.3-codex': 'legacy',
    'gpt-5.4': 'legacy',
    'gpt-5.4-mini': 'legacy',
    'gpt-5.4-nano': 'legacy',
    'gpt-5.4-pro': 'legacy',
    'gpt-5.5': 'legacy',
    'gpt-5.5-pro': 'legacy',
    'gpt-5.6-luna': 'legacy',
    'gpt-5.6-sol': 'legacy',
    'gpt-5.6-terra': 'legacy',
    'gpt-6-astra': 'legacy',
    'gpt-6-luna': ['latest', 'test'],
    'gpt-6-sol': 'legacy',
    'gpt-6.1-sol': 'legacy',
    'gpt-6.1-terra': 'latest',
    'gpt-6.2-astra': 'latest',
    'gpt-6.2-sol': 'latest',
    'o3': 'legacy',
    'o3-pro': 'legacy',
    // *** google
    'gemini-2.5-flash': 'legacy',
    'gemini-2.5-flash-image': 'legacy',
    'gemini-2.5-flash-lite': 'legacy',
    'gemini-2.5-pro': 'legacy',
    'gemini-3-flash-preview': 'legacy',
    'gemini-3-pro-image': 'legacy',
    'gemini-3.1-flash-image': 'legacy',
    'gemini-3.1-flash-lite': 'legacy',
    'gemini-3.1-flash-lite-image': 'legacy',
    'gemini-3.1-flash-lite-preview': 'legacy',
    'gemini-3.1-pro-preview': 'legacy',
    'gemini-3.5-flash': 'legacy',
    'gemini-3.5-flash-lite': 'legacy',
    'gemini-3.6-flash': 'legacy',
    'gemini-3.7-flash': 'legacy',
    'gemini-3.8-flash': 'legacy',
    'gemini-4-argon': 'latest',
    'gemini-4-carbon': 'latest',
    'gemini-4-hydrogen': ['latest', 'test'],
    'gemini-nano-banana-2.1': 'latest',
    'gemini-robotics-er-2-preview': 'legacy',
};

export function modelHasTier(modelId: string, tier: ModelTier): boolean {
    const assignment = MODEL_TIERS[modelId] ?? 'new';
    return typeof assignment === 'string'
        ? assignment === tier
        : assignment.includes(tier);
}

export function visibleModelTier(modelId: string): VisibleModelTier {
    const assignment = MODEL_TIERS[modelId] ?? 'new';
    return typeof assignment === 'string' ? assignment : assignment[0];
}
