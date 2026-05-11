// Hand-curated values that provider APIs and OpenRouter's model catalog can't
// tell us reliably. Keep this file small: prefer live provider/OpenRouter data
// whenever it maps cleanly to packages/courierai_web/src/lib/models/types.ts.

import type { ThinkingLevel } from '../packages/courierai_web/src/lib/models/types';

interface ThinkingOverride {
    levels: ThinkingLevel[];
    defaultLevel: ThinkingLevel;
}

interface ModelOverride {
    // When the first-party id and OpenRouter's local id differ.
    openRouterId?: string;
    // When we expose a stable alias rather than the provider's canonical id.
    idAlias?: string;
    name?: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    temperatureMax?: number;
    defaultTemperature?: number;
    knowledgeCutoff?: string;
    thinking?: ThinkingOverride;
    // Anthropic's API exposes effort levels, but occasionally docs mention an
    // additional level before the API enum catches up.
    thinkingExtraLevels?: ThinkingLevel[];
}

// Anthropic's /v1/models response is rich. The only routine gaps are
// knowledgeCutoff, aliases for date-suffixed ids, and rare extra effort levels.
export const ANTHROPIC_OVERRIDES: Record<string, ModelOverride> = {
    'claude-opus-4-7': {
        knowledgeCutoff: 'Jan 2026',
        thinkingExtraLevels: ['xhigh'],
    },
    'claude-sonnet-4-6': { knowledgeCutoff: 'Aug 2025' },
    'claude-opus-4-6': { knowledgeCutoff: 'May 2025' },
    'claude-haiku-4-5-20251001': {
        idAlias: 'claude-haiku-4-5',
        knowledgeCutoff: 'Feb 2025',
    },
};

// OpenAI's own /models endpoint is barebones, but OpenRouter fills most of the
// CourierAI model params.
export const OPENAI_OVERRIDES: Record<string, ModelOverride> = {
};

// Google's API gives token limits and temperature. OpenRouter helps identify
// reasoning-capable models, but it does not enumerate Google's thinking levels,
// so only those level/default choices live here.
export const GOOGLE_OVERRIDES: Record<string, ModelOverride> = {
    'gemini-2.5-pro': {
        thinking: {
            levels: ['low', 'medium', 'high', 'max'],
            defaultLevel: 'medium',
        },
    },
    'gemini-3-flash-preview': {
        thinking: {
            levels: ['none', 'low', 'medium', 'high'],
            defaultLevel: 'high',
        },
    },
    'gemini-3.1-pro-preview': {
        thinking: {
            levels: ['none', 'low', 'high'],
            defaultLevel: 'high',
        },
    },
};
