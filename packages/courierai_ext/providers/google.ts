import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { streamText } from 'ai';
import type { StreamArgs } from './anthropic';
import { makeDebugFetch } from './debug-fetch';

// Google's web search tool name. Hoisted for consistency with other
// providers — it's the key on `google.tools`.
const WEB_SEARCH_TOOL = 'googleSearch' as const;

// Gemini 2.5 budgets — explicit token counts (positive = budget, 0 = off).
// Gemini 3+ uses the thinkingLevel enum instead.
const BUDGETS_2_5: Record<string, number> = {
    low: 512,
    medium: 4096,
    high: 8192,
    max: 16384,
    xhigh: 24576,
};

type ThinkingLevelEnum = 'minimal' | 'low' | 'medium' | 'high';

// Gemini 3.x accepts a level enum; max/xhigh clamp to 'high'.
function toThinkingLevel(level: string): ThinkingLevelEnum | undefined {
    if (level === 'minimal' || level === 'low' || level === 'medium') {
        return level;
    }
    if (level === 'high' || level === 'max' || level === 'xhigh') {
        return 'high';
    }
    return undefined;
}

// Plain JSON-cloneable shape so it satisfies providerOptions' JSONValue
// constraint. Build the object incrementally so absent keys don't surface
// as `undefined`-typed properties.
type ThinkingConfig = Record<string, number | boolean | string>;

function buildThinkingConfig(
    model: string,
    thinkingLevel: string | undefined,
    adaptive: boolean
): ThinkingConfig | undefined {
    if (!thinkingLevel || thinkingLevel === 'none') return undefined;

    // Adaptive == let the model decide (thinkingBudget: -1).
    if (adaptive) {
        return { thinkingBudget: -1, includeThoughts: true };
    }

    if (model.includes('2.5')) {
        const budget = BUDGETS_2_5[thinkingLevel];
        if (budget == null) return undefined;
        return { thinkingBudget: Math.max(128, budget), includeThoughts: true };
    }

    const level = toThinkingLevel(thinkingLevel);
    if (!level) return undefined;
    return { thinkingLevel: level, includeThoughts: true };
}

export function streamGoogle(args: StreamArgs) {
    const google = createGoogleGenerativeAI({
        apiKey: args.apiKey,
        fetch: makeDebugFetch('google'),
    });

    const adaptive =
        (args.params.adaptiveThinking as boolean | undefined) ?? true;
    const thinkingConfig = buildThinkingConfig(
        args.model,
        args.params.thinkingLevel as string | undefined,
        adaptive
    );
    const maxTokens = (args.params.maxTokens as number | undefined) ?? 8192;

    const tools = args.params.webSearch
        ? { google_search: google.tools[WEB_SEARCH_TOOL]({}) }
        : undefined;

    return streamText({
        model: google(args.model),
        messages: args.messages,
        maxOutputTokens: maxTokens,
        ...(args.system ? { system: args.system } : {}),
        ...(args.params.temperature !== undefined
            ? { temperature: args.params.temperature as number }
            : {}),
        ...(tools ? { tools } : {}),
        ...(args.signal ? { abortSignal: args.signal } : {}),
        ...(thinkingConfig
            ? { providerOptions: { google: { thinkingConfig } } }
            : {}),
    });
}
