import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { streamText } from 'ai';
import type { StreamArgs } from './anthropic';
import { makeDebugFetch } from './debug-fetch';

// OpenRouter's web search tool factory. Hoisted for consistency with the
// other providers — same place to look for the tool wiring.
const WEB_SEARCH_TOOL = 'webSearch' as const;

type Effort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

// Our thinkingLevel vocabulary → OpenRouter's reasoning.effort enum. 'max'
// clamps to 'xhigh'; 'none' returns undefined to skip the field.
function toEffort(level: string | undefined): Effort | undefined {
    if (!level || level === 'none') return undefined;
    if (level === 'max') return 'xhigh';
    if (
        level === 'minimal' ||
        level === 'low' ||
        level === 'medium' ||
        level === 'high' ||
        level === 'xhigh'
    ) {
        return level;
    }
    return undefined;
}

export function streamOpenRouter(args: StreamArgs) {
    // App attribution headers are opt-in via the user setting — when off,
    // the request goes through unattributed.
    const openrouter = createOpenRouter({
        apiKey: args.apiKey,
        fetch: makeDebugFetch('openrouter'),
        ...(args.params.tagOpenRouterRequests
            ? {
                  appName: 'CourierAI',
                  appUrl: 'https://courierai.net',
              }
            : {}),
    });

    const effort = toEffort(args.params.thinkingLevel as string | undefined);
    const maxTokens = (args.params.maxTokens as number | undefined) ?? 8192;

    const tools = args.params.webSearch
        ? { web_search: openrouter.tools[WEB_SEARCH_TOOL]({}) }
        : undefined;

    return streamText({
        model: openrouter(args.model),
        messages: args.messages,
        maxOutputTokens: maxTokens,
        ...(args.system ? { system: args.system } : {}),
        ...(args.params.temperature !== undefined
            ? { temperature: args.params.temperature as number }
            : {}),
        ...(tools ? { tools } : {}),
        ...(args.signal ? { abortSignal: args.signal } : {}),
        ...(effort
            ? {
                  providerOptions: {
                      openrouter: {
                          reasoning: { effort, summary: 'auto' },
                      },
                  },
              }
            : {}),
    });
}
