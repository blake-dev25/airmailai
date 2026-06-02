// Hand-curated values that provider APIs and OpenRouter's model catalog can't
// tell us reliably. Keep this file small: prefer live provider/OpenRouter data
// whenever it maps cleanly to packages/courierai_web/src/lib/models/types.ts.

import type {
    ModelTools,
    ThinkingLevel,
} from '../../packages/courierai_web/src/lib/models/types';

interface ThinkingOverride {
    levels: ThinkingLevel[];
    defaultLevel: ThinkingLevel;
}

export interface ModelOverride {
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
    // Server-side tool support. For anthropic, the string IS the Anthropic
    // API tool `type` (versioned by date). Other providers use booleans.
    // /v1/models returns code_execution support as a boolean but not the
    // version string - so even when the API confirms support, we still
    // pin the version here.
    tools?: ModelTools;
}

// Anthropic tool-version pinning, sourced from the per-tool docs at
// https://platform.claude.com/docs/en/agents-and-tools/tool-use/
// (web-search-tool, web-fetch-tool, code-execution-tool). Older models can't
// use the newer _20260209 variants because they don't support programmatic
// tool calling - we pin them to the direct-only legacy versions instead.
const ANTHROPIC_TOOLS_LATEST: ModelTools = {
    webSearch: 'web_search_20260209',
    webFetch: 'web_fetch_20260209',
    codeExecution: 'code_execution_20260120',
};
const ANTHROPIC_TOOLS_4_5: ModelTools = {
    webSearch: 'web_search_20250305',
    webFetch: 'web_fetch_20250910',
    codeExecution: 'code_execution_20260120',
};
const ANTHROPIC_TOOLS_HAIKU_4_5: ModelTools = {
    webSearch: 'web_search_20250305',
    webFetch: 'web_fetch_20250910',
    codeExecution: 'code_execution_20250825',
};
const ANTHROPIC_TOOLS_LEGACY: ModelTools = {
    webSearch: 'web_search_20250305',
    webFetch: 'web_fetch_20250910',
    codeExecution: 'code_execution_20250825',
};

// Anthropic's /v1/models response is rich. The only routine gaps are
// knowledgeCutoff, aliases for date-suffixed ids, rare extra effort levels,
// and tool version strings (capabilities.code_execution gives boolean
// support but not the version).
export const ANTHROPIC_OVERRIDES: Record<string, ModelOverride> = {
    'claude-opus-4-8': {
        knowledgeCutoff: 'Jan 2026',
        tools: ANTHROPIC_TOOLS_LATEST,
    },
    'claude-opus-4-7': {
        knowledgeCutoff: 'Jan 2026',
        thinkingExtraLevels: ['xhigh'],
        tools: ANTHROPIC_TOOLS_LATEST,
    },
    'claude-sonnet-4-6': {
        knowledgeCutoff: 'Aug 2025',
        tools: ANTHROPIC_TOOLS_LATEST,
    },
    'claude-opus-4-6': {
        knowledgeCutoff: 'May 2025',
        tools: ANTHROPIC_TOOLS_LATEST,
    },
    'claude-opus-4-5-20251101': { tools: ANTHROPIC_TOOLS_4_5 },
    'claude-sonnet-4-5-20250929': { tools: ANTHROPIC_TOOLS_4_5 },
    'claude-haiku-4-5-20251001': {
        idAlias: 'claude-haiku-4-5',
        knowledgeCutoff: 'Feb 2025',
        tools: ANTHROPIC_TOOLS_HAIKU_4_5,
    },
    'claude-opus-4-1-20250805': { tools: ANTHROPIC_TOOLS_LEGACY },
    'claude-opus-4-20250514': { tools: ANTHROPIC_TOOLS_LEGACY },
    'claude-sonnet-4-20250514': { tools: ANTHROPIC_TOOLS_LEGACY },
};

// OpenAI's web_search server tool covers both search and open_page (fetch);
// we expose them as one combined toggle via searchFetchLinked. code_interpreter
// is supported on the reasoning + GPT-5 family.
const OPENAI_TOOLS_FULL: ModelTools = {
    webSearch: true,
    webFetch: true,
    codeExecution: true,
    searchFetchLinked: true,
};

// OpenAI's own /models endpoint is barebones, but OpenRouter fills most of the
// CourierAI model params. Tool support comes from the OpenAI docs and is
// hand-mapped here - the bare /models response doesn't enumerate it.
export const OPENAI_OVERRIDES: Record<string, ModelOverride> = {
    'gpt-5.5-pro': { tools: OPENAI_TOOLS_FULL },
    'gpt-5.5': { tools: OPENAI_TOOLS_FULL },
    'gpt-5.4-mini': { tools: OPENAI_TOOLS_FULL },
    'gpt-5.4-nano': { tools: OPENAI_TOOLS_FULL },
    'gpt-5.1': { tools: OPENAI_TOOLS_FULL },
    'gpt-5.1-mini': { tools: OPENAI_TOOLS_FULL },
    'gpt-5.1-nano': { tools: OPENAI_TOOLS_FULL },
    'gpt-5': { tools: OPENAI_TOOLS_FULL },
    'gpt-5-mini': { tools: OPENAI_TOOLS_FULL },
    'gpt-5-nano': { tools: OPENAI_TOOLS_FULL },
};

const GOOGLE_TOOLS_FULL: ModelTools = {
    webSearch: true,
    webFetch: true,
    codeExecution: true,
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
        tools: GOOGLE_TOOLS_FULL,
    },
    'gemini-2.5-flash': { tools: GOOGLE_TOOLS_FULL },
    'gemini-3-flash-preview': {
        thinking: {
            levels: ['none', 'low', 'medium', 'high'],
            defaultLevel: 'high',
        },
        tools: GOOGLE_TOOLS_FULL,
    },
    'gemini-3.1-pro-preview': {
        thinking: {
            levels: ['none', 'low', 'high'],
            defaultLevel: 'high',
        },
        tools: GOOGLE_TOOLS_FULL,
    },
};
