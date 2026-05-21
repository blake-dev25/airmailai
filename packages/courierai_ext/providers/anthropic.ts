import { createAnthropic } from '@ai-sdk/anthropic';
import { streamText, type ModelMessage } from 'ai';
import { makeDebugFetch } from './debug-fetch';

// Anthropic versions server-side tool definitions by date. Bumping the
// suffix is the one-liner that breaks the SDK call at runtime — keep it
// visible up here rather than buried in the request body.
const WEB_SEARCH_TOOL = 'webSearch_20260209' as const;

// Manual-mode budget_tokens (only used when adaptiveThinking is false). The
// `effort` knob drives depth on Opus 4.7+; for older Sonnet/Opus, depth
// comes from the budget itself.
const BUDGET_TOKENS: Record<string, number> = {
    low: 2048,
    medium: 8192,
    high: 16000,
    max: 32000,
};

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface StreamArgs {
    apiKey: string;
    model: string;
    messages: ModelMessage[];
    system?: string;
    params: Record<string, unknown>;
    signal?: AbortSignal;
}

export function streamAnthropic(args: StreamArgs) {
    // `anthropic-dangerous-direct-browser-access: true` is required for the
    // SDK to skip its CORS preflight, since we're calling from a Chrome MV3
    // service worker. Without it, the preflight 403s.
    const anthropic = createAnthropic({
        apiKey: args.apiKey,
        headers: { 'anthropic-dangerous-direct-browser-access': 'true' },
        fetch: makeDebugFetch('anthropic'),
    });

    const thinkingLevel = args.params.thinkingLevel as string | undefined;
    const thinkingEnabled = !!thinkingLevel && thinkingLevel !== 'none';
    const adaptiveThinking =
        (args.params.adaptiveThinking as boolean | undefined) ?? true;
    const maxTokens = (args.params.maxTokens as number | undefined) ?? 8192;

    const thinkingConfig = thinkingEnabled
        ? adaptiveThinking
            ? { thinking: { type: 'adaptive' as const } }
            : {
                  thinking: {
                      type: 'enabled' as const,
                      // budget_tokens must be < max_tokens per Anthropic API
                      budgetTokens: Math.min(
                          BUDGET_TOKENS[thinkingLevel] ?? BUDGET_TOKENS.high,
                          Math.max(1024, maxTokens - 1024)
                      ),
                  },
              }
        : undefined;

    // effort + adaptive thinking is an Opus 4.7+ combination. Pre-4.7 models
    // ignore `effort`, so passing it through is harmless.
    const effort: Effort | undefined =
        thinkingEnabled &&
        (thinkingLevel === 'low' ||
            thinkingLevel === 'medium' ||
            thinkingLevel === 'high' ||
            thinkingLevel === 'xhigh' ||
            thinkingLevel === 'max')
            ? thinkingLevel
            : undefined;

    const tools = args.params.webSearch
        ? {
              web_search: anthropic.tools[WEB_SEARCH_TOOL]({ maxUses: 5 }),
          }
        : undefined;

    return streamText({
        model: anthropic(args.model),
        messages: args.messages,
        maxOutputTokens: maxTokens,
        ...(args.system ? { system: args.system } : {}),
        ...(args.params.temperature !== undefined
            ? { temperature: args.params.temperature as number }
            : {}),
        ...(tools ? { tools } : {}),
        ...(args.signal ? { abortSignal: args.signal } : {}),
        ...(thinkingConfig || effort
            ? {
                  providerOptions: {
                      anthropic: {
                          ...(thinkingConfig ?? {}),
                          ...(effort ? { effort } : {}),
                      },
                  },
              }
            : {}),
    });
}
