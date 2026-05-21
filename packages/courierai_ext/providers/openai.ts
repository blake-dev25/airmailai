import { createOpenAI } from '@ai-sdk/openai';
import { streamText } from 'ai';
import type { StreamArgs } from './anthropic';
import { makeDebugFetch } from './debug-fetch';

// OpenAI's web search tool is exposed by the SDK as `openai.tools.webSearch`.
// Hoisted so the wiring is in a consistent place across providers.
const WEB_SEARCH_TOOL = 'webSearch' as const;

type Effort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

// Our thinkingLevel vocabulary → OpenAI's reasoning.effort enum. 'max' has
// no equivalent and clamps to 'xhigh'; 'none' returns undefined to skip.
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

export function streamOpenAI(args: StreamArgs) {
    const openai = createOpenAI({
        apiKey: args.apiKey,
        fetch: makeDebugFetch('openai'),
    });

    const effort = toEffort(args.params.thinkingLevel as string | undefined);
    const maxTokens = (args.params.maxTokens as number | undefined) ?? 8192;

    const tools = args.params.webSearch
        ? { web_search: openai.tools[WEB_SEARCH_TOOL]() }
        : undefined;

    return streamText({
        model: openai.responses(args.model),
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
                      openai: {
                          reasoningEffort: effort,
                          reasoningSummary: 'auto',
                          // Required so encrypted reasoning items survive
                          // stateless multi-turn replays — without it,
                          // each web_search_call loses its bound reasoning
                          // ref and the next turn errors with "ws_X
                          // provided without required rs_Y".
                          include: ['reasoning.encrypted_content'],
                      },
                  },
              }
            : {}),
    });
}
