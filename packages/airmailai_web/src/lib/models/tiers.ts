import type { ModelTier, ModelTierAssignment, VisibleModelTier } from './types';

// *** Manually curated. Unknown ids fall through to 'legacy', so new models
// never auto-surface in 'latest' or 'previous' without explicit promotion.
// 'test' tier is used for playwright testing and not exposed in the UI.
export const MODEL_TIERS: Record<string, ModelTierAssignment> = {
    // *** anthropic
    'claude-fable-5': 'previous',
    'claude-fable-5-1': 'latest',
    'claude-haiku-4-5': 'latest',
    'claude-opus-4-5-20251101': 'legacy',
    'claude-opus-4-6': 'legacy',
    'claude-opus-4-7': 'legacy',
    'claude-opus-4-8': 'previous',
    'claude-opus-5': 'latest',
    'claude-sonnet-4-5-20250929': 'legacy',
    'claude-sonnet-4-6': 'previous',
    'claude-sonnet-5': ['latest', 'test'],
    // *** openai
    'gpt-3.5-turbo': 'legacy',
    'gpt-3.5-turbo-16k': 'legacy',
    'gpt-4': 'legacy',
    'gpt-4-turbo': 'legacy',
    'gpt-4.1': 'previous',
    'gpt-4.1-mini': 'legacy',
    'gpt-4.1-nano': 'legacy',
    'gpt-4o': 'legacy',
    'gpt-4o-mini': 'legacy',
    'gpt-5': 'legacy',
    'gpt-5-mini': 'legacy',
    'gpt-5-nano': 'legacy',
    'gpt-5-pro': 'legacy',
    'gpt-5.1': 'legacy',
    'gpt-5.2': 'legacy',
    'gpt-5.2-pro': 'legacy',
    'gpt-5.3-codex': 'previous',
    'gpt-5.4': 'previous',
    'gpt-5.4-mini': 'legacy',
    'gpt-5.4-nano': 'legacy',
    'gpt-5.4-pro': 'legacy',
    'gpt-5.5': 'previous',
    'gpt-5.5-pro': 'previous',
    'gpt-5.6-luna': 'latest',
    'gpt-5.6-sol': 'latest',
    'gpt-5.6-terra': ['latest', 'test'],
    'o1': 'legacy',
    'o1-pro': 'legacy',
    'o3': 'legacy',
    'o3-mini': 'legacy',
    'o3-pro': 'legacy',
    'o4-mini': 'legacy',
    // *** google
    'antigravity-preview-05-2026': 'previous',
    'deep-research-max-preview-04-2026': 'legacy',
    'deep-research-preview-04-2026': 'legacy',
    'deep-research-pro-preview-12-2025': 'legacy',
    'gemini-2.5-computer-use-preview-10-2025': 'legacy',
    'gemini-2.5-flash': 'legacy',
    'gemini-2.5-flash-image': 'legacy',
    'gemini-2.5-flash-lite': 'legacy',
    'gemini-2.5-pro': 'legacy',
    'gemini-3-flash-preview': 'legacy',
    'gemini-3-pro-image': 'legacy',
    'gemini-3.1-flash-image': 'legacy',
    'gemini-3.1-flash-lite': 'previous',
    'gemini-3.1-flash-lite-image': 'legacy',
    'gemini-3.1-flash-lite-preview': 'previous',
    'gemini-3.1-pro-preview': 'latest',
    'gemini-3.5-flash': 'legacy',
    'gemini-3.5-flash-lite': 'latest',
    'gemini-3.6-flash': 'legacy',
    'gemini-3.7-flash': 'previous',
    'gemini-3.8-flash': ['latest', 'test'],
    'gemini-robotics-er-2-preview': 'legacy',
};

export function modelHasTier(modelId: string, tier: ModelTier): boolean {
    const assignment = MODEL_TIERS[modelId] ?? 'legacy';
    return typeof assignment === 'string'
        ? assignment === tier
        : assignment.includes(tier);
}

export function visibleModelTier(modelId: string): VisibleModelTier {
    const assignment = MODEL_TIERS[modelId] ?? 'legacy';
    return typeof assignment === 'string' ? assignment : assignment[0];
}
