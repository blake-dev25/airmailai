import type {
    HydratedChatMessage,
    StreamHandlers,
    StreamUsage,
    WebSearchToolResult,
} from '@courier/shared';
import OpenAI from 'openai';
import { DEBUG_API_LOGGING } from '../debug';
import {
    buildResponsesToolResults,
    collectUrlCitationSources,
    collectWebSearchCallIds,
} from './tool-results';

const LOG = '[courier:ext]';

function messageInputItem(
    msg: HydratedChatMessage
): OpenAI.Responses.EasyInputMessage {
    if (!msg.attachments?.length) {
        return { role: msg.role as 'user' | 'assistant', content: msg.content };
    }

    const parts: OpenAI.Responses.ResponseInputContent[] = [];

    for (const att of msg.attachments) {
        if (att.mediaType.startsWith('image/')) {
            parts.push({
                type: 'input_image',
                detail: 'auto',
                image_url: `data:${att.mediaType};base64,${att.data}`,
            });
        } else {
            parts.push({
                type: 'input_file',
                filename: att.name,
                file_data: `data:${att.mediaType};base64,${att.data}`,
            });
        }
    }

    if (msg.content) {
        parts.push({ type: 'input_text', text: msg.content });
    }

    return { role: msg.role as 'user' | 'assistant', content: parts };
}

// Re-inject prior `web_search_call` items so the model knows it already
// searched. The Responses API accepts these directly in the input array.
function webSearchCallItems(
    toolResults: WebSearchToolResult[]
): OpenAI.Responses.ResponseFunctionWebSearch[] {
    return toolResults
        .filter((tr) => !!tr.callId)
        .map((tr) => ({
            type: 'web_search_call',
            id: tr.callId!,
            status: 'completed',
            action: { type: 'search', query: '' },
        }));
}

// Build the flat list of input items for the Responses API. Prior web search
// calls go in *before* the assistant message they belong to.
function toResponsesInput(
    messages: HydratedChatMessage[]
): OpenAI.Responses.ResponseInputItem[] {
    const items: OpenAI.Responses.ResponseInputItem[] = [];
    for (const msg of messages) {
        if (msg.role === 'assistant' && msg.toolResults?.length) {
            items.push(...webSearchCallItems(msg.toolResults));
        }
        items.push(messageInputItem(msg));
    }
    return items;
}

export async function streamOpenAI(
    apiKey: string,
    model: string,
    messages: HydratedChatMessage[],
    params: Record<string, unknown>,
    handlers: StreamHandlers,
    signal?: AbortSignal
): Promise<void> {
    const client = new OpenAI({ apiKey, dangerouslyAllowBrowser: true });

    const systemMsg = messages.find((m) => m.role === 'system');
    const inputItems = toResponsesInput(
        messages.filter((m) => m.role !== 'system')
    );

    const thinkingLevel = params.thinkingLevel as string | undefined;
    const thinkingEnabled = thinkingLevel && thinkingLevel !== 'none';

    console.log(LOG, 'openai: stream start', {
        model,
        inputItems: inputItems.length,
        hasSystem: !!systemMsg,
        params,
    });

    try {
        const stream = await client.responses.create(
            {
                model,
                input: inputItems,
                ...(systemMsg ? { instructions: systemMsg.content } : {}),
                max_output_tokens: (params.maxTokens as number) ?? 8192,
                ...(params.temperature !== undefined
                    ? { temperature: params.temperature as number }
                    : {}),
                ...(thinkingEnabled
                    ? {
                          reasoning: {
                              effort: thinkingLevel,
                              summary: 'auto',
                          } as never,
                      }
                    : {}),
                ...(params.webSearch
                    ? { tools: [{ type: 'web_search' }] }
                    : {}),
                stream: true,
            },
            { signal }
        );

        let firstChunk = true;
        let usage: StreamUsage | undefined;
        let toolResults: WebSearchToolResult[] = [];

        for await (const event of stream) {
            if (event.type === 'response.output_text.delta') {
                if (firstChunk) {
                    console.log(LOG, 'openai: first chunk received');
                    firstChunk = false;
                }
                handlers.onChunk(event.delta);
            } else if (event.type === 'response.reasoning_summary_text.delta') {
                handlers.onThinking?.((event as { delta: string }).delta);
            } else if (event.type === 'response.completed') {
                if (DEBUG_API_LOGGING) {
                    console.log(LOG, '[debug] full response', event.response);
                }
                const u = event.response.usage;
                if (u) {
                    usage = {
                        inputTokens: u.input_tokens,
                        outputTokens: u.output_tokens,
                    };
                }
                toolResults = buildResponsesToolResults(
                    collectWebSearchCallIds(event.response),
                    collectUrlCitationSources(event.response)
                );
            }
        }

        if (toolResults.length) handlers.onToolResults?.(toolResults);
        console.log(LOG, 'openai: stream done');
        handlers.onDone(usage);
    } catch (e) {
        if (signal?.aborted) return;
        const msg = e instanceof Error ? e.message : String(e);
        console.error(LOG, 'openai: error', msg);
        handlers.onError(msg);
    }
}
