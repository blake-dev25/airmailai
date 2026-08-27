import type {
    ModelTools,
    ThinkingLevel,
} from '../../packages/airmailai_web/src/lib/models/types';
import { type DerivedModel, sortLevels } from './shared';

interface ThinkingOverride {
    levels: ThinkingLevel[];
    defaultLevel: ThinkingLevel;
    adaptive?: 'optional' | 'required';
}

export interface ModelOverride {
    openRouterId?: string;
    idAlias?: string;
    name?: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    temperatureMax?: number;
    defaultTemperature?: number;
    knowledgeCutoff?: string;
    thinking?: ThinkingOverride;
    thinkingExtraLevels?: ThinkingLevel[];
    // *** Server-side tool support. Only anthropic pins tools here: the string
    // IS the Anthropic API tool `type` (versioned by date), and /v1/models
    // returns code_execution support as a boolean but not the version string.
    // OpenAI/Google version their server tools globally, so their support is
    // attached provider-wide in packages/airmailai_web/src/lib/models/index.ts.
    tools?: ModelTools;
}

export function staleOverrideIds(
    overrides: Record<string, ModelOverride>,
    models: DerivedModel[]
): string[] {
    const ids = new Set(models.map((m) => m.id));
    return Object.entries(overrides)
        .filter(
            ([key, o]) => !ids.has(key) && !(o.idAlias && ids.has(o.idAlias))
        )
        .map(([key]) => key);
}

export function applyOverride(m: DerivedModel, o: ModelOverride): void {
    if (o.idAlias) m.id = o.idAlias;
    if (o.name !== undefined) m.name = o.name;
    if (o.contextWindow !== undefined) m.contextWindow = o.contextWindow;
    if (o.maxOutputTokens !== undefined) m.maxOutputTokens = o.maxOutputTokens;
    if (o.temperatureMax !== undefined) m.temperatureMax = o.temperatureMax;
    if (o.defaultTemperature !== undefined)
        m.defaultTemperature = o.defaultTemperature;
    if (o.knowledgeCutoff !== undefined) m.knowledgeCutoff = o.knowledgeCutoff;
    if (o.thinking) {
        const adaptive = o.thinking.adaptive ?? m.thinking?.adaptive;
        m.thinking = {
            levels: sortLevels(o.thinking.levels),
            defaultLevel: o.thinking.defaultLevel,
            ...(adaptive ? { adaptive } : {}),
        };
    }
    if (o.thinkingExtraLevels && m.thinking) {
        m.thinking.levels = sortLevels([
            ...m.thinking.levels,
            ...o.thinkingExtraLevels,
        ]);
    }
    if (o.tools) m.tools = o.tools;
}

// *** Anthropic tool-version pinning, sourced from the per-tool docs at
// https://platform.claude.com/docs/en/agents-and-tools/tool-use/
// (web-search-tool, web-fetch-tool, code-execution-tool). Models without a
// tools override default to ANTHROPIC_TOOLS_LATEST - new Anthropic models
// support the latest variants. Older models can't use the newer _20260209
// variants because they don't support programmatic tool calling - we pin
// them to the direct-only legacy versions below.
export const ANTHROPIC_TOOLS_LATEST: ModelTools = {
    webSearch: 'web_search_20260318',
    webFetch: 'web_fetch_20260318',
    codeExecution: 'code_execution_20260521',
};
const ANTHROPIC_TOOLS_4_5: ModelTools = {
    webSearch: 'web_search_20250305',
    webFetch: 'web_fetch_20250910',
    codeExecution: 'code_execution_20260521',
};
const ANTHROPIC_TOOLS_LEGACY: ModelTools = {
    webSearch: 'web_search_20250305',
    webFetch: 'web_fetch_20250910',
    codeExecution: 'code_execution_20250825',
};

// *** Anthropic's /v1/models response is rich, and knowledgeCutoff comes from
// scraping the models overview docs page. The only routine gaps are aliases
// for date-suffixed ids, rare extra effort levels, and non-latest tool
// version pins (capabilities.code_execution gives boolean support but not
// the version, and unpinned models default to ANTHROPIC_TOOLS_LATEST).
export const ANTHROPIC_OVERRIDES: Record<string, ModelOverride> = {
    // *** Fable 5 rejects thinking: {type: "disabled"} (400) - thinking is
    // always on, so a 'none' level would silently run adaptive thinking at
    // default effort. Derived adaptive: 'required' is preserved by the
    // override-apply helpers.
    'claude-fable-5': {
        thinking: {
            levels: ['low', 'medium', 'high', 'xhigh', 'max'],
            defaultLevel: 'high',
        },
    },
    'claude-opus-4-8': { thinkingExtraLevels: ['xhigh'] },
    'claude-opus-4-7': { thinkingExtraLevels: ['xhigh'] },
    'claude-opus-4-5-20251101': { tools: ANTHROPIC_TOOLS_4_5 },
    'claude-sonnet-4-5-20250929': { tools: ANTHROPIC_TOOLS_4_5 },
    'claude-haiku-4-5-20251001': {
        idAlias: 'claude-haiku-4-5',
        tools: ANTHROPIC_TOOLS_LEGACY,
    },
};

// *** OpenAI's own /models endpoint is barebones, but OpenRouter fills most of the
// AirmailAI model params.
// *** Pre-gpt-5.1 reasoning models default to medium effort and reject
// 'none' (per the openai SDK ReasoningEffort docs), so the generic
// none/low/high fallback would mislabel them - the o-series gets explicit
// low/medium/high here. gpt-5-pro "defaults to (and only supports)
// reasoning.effort: high" per its model docs page.
const O_SERIES_THINKING: ThinkingOverride = {
    levels: ['low', 'medium', 'high'],
    defaultLevel: 'medium',
};

export const OPENAI_OVERRIDES: Record<string, ModelOverride> = {
    'gpt-5-pro': {
        thinking: { levels: ['high'], defaultLevel: 'high' },
    },
    o1: { thinking: O_SERIES_THINKING },
    'o1-pro': { thinking: O_SERIES_THINKING },
    o3: { thinking: O_SERIES_THINKING },
    'o3-mini': { thinking: O_SERIES_THINKING },
    'o3-pro': { thinking: O_SERIES_THINKING },
    'o4-mini': { thinking: O_SERIES_THINKING },
};

// *** Google's API gives token limits and temperature. Thinking levels come
// from the model table scraped off
// https://ai.google.dev/gemini-api/docs/thinking; overrides remain only where
// that table falls short:
// - 2.5 models take thinkingBudget; 0 disables (except Pro, which can't
//   disable), -1 is dynamic (the API default for Pro and Flash). The table
//   doesn't express the budget-derived 'max' level or adaptive: 'optional',
//   so the 2.5 trio stays pinned here.
// - Models absent from the table (currently gemini-3.1-flash-lite and its
//   preview) keep hand-sourced levels. Gemini 3+ models cannot disable
//   thinking, so no 'none' level.
export const GOOGLE_OVERRIDES: Record<string, ModelOverride> = {
    'gemini-2.5-pro': {
        thinking: {
            levels: ['low', 'medium', 'high', 'max'],
            defaultLevel: 'medium',
            adaptive: 'optional',
        },
    },
    'gemini-2.5-flash': {
        thinking: {
            levels: ['none', 'low', 'medium', 'high', 'max'],
            defaultLevel: 'medium',
            adaptive: 'optional',
        },
    },
    'gemini-2.5-flash-lite': {
        thinking: {
            levels: ['none', 'low', 'medium', 'high', 'max'],
            defaultLevel: 'none',
            adaptive: 'optional',
        },
    },
    'gemini-3.1-flash-lite-preview': {
        thinking: {
            levels: ['minimal', 'low', 'medium', 'high'],
            defaultLevel: 'minimal',
        },
    },
    'gemini-3.1-flash-lite': {
        thinking: {
            levels: ['minimal', 'low', 'medium', 'high'],
            defaultLevel: 'minimal',
        },
    },
};
