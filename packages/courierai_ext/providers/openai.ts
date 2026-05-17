import type {
    HydratedChatMessage,
    StreamHandlers,
    StreamUsage,
    WebSearchToolResult,
} from '@courier/shared';
import OpenAI from 'openai';
import { DEBUG_API_LOGGING } from '../debug';
import { buildOpenAIResponsesToolResults } from './tool-results';

const LOG = '[courier:ext]';

// OpenAI's web search tool type string. Hoisted so it lives next to the
// other tool-shape choices for this provider — easy to spot/swap if OpenAI
// renames it.
const WEB_SEARCH_TOOL_TYPE = 'web_search' as const;

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

// Re-inject prior reasoning + `web_search_call` items so the model knows it
// already searched. The API binds each web_search_call to a preceding
// reasoning item by id; both must be present on stateless multi-turn calls.
// Reasoning items come first to match the order in the original response.
function webSearchPrefixItems(
    toolResults: WebSearchToolResult[]
): OpenAI.Responses.ResponseInputItem[] {
    const items: OpenAI.Responses.ResponseInputItem[] = [];
    for (const tr of toolResults) {
        for (const r of tr.openaiReasoning ?? []) {
            items.push({
                type: 'reasoning',
                id: r.id,
                summary: [],
                encrypted_content: r.encryptedContent,
            });
        }
        if (tr.callId) {
            items.push({
                type: 'web_search_call',
                id: tr.callId,
                status: 'completed',
                action: { type: 'search', query: '' },
            });
        }
    }
    return items;
}

// Build the flat list of input items for the Responses API. Prior web search
// calls go in *before* the assistant message they belong to.
function toResponsesInput(
    messages: HydratedChatMessage[]
): OpenAI.Responses.ResponseInputItem[] {
    const items: OpenAI.Responses.ResponseInputItem[] = [];
    for (const msg of messages) {
        if (msg.role === 'assistant' && msg.toolResults?.length) {
            items.push(...webSearchPrefixItems(msg.toolResults));
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

    const requestBody = {
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
                      effort: thinkingLevel as OpenAI.Reasoning['effort'],
                      summary: 'auto' as const,
                  },
              }
            : {}),
        ...(params.webSearch
            ? {
                  tools: [{ type: WEB_SEARCH_TOOL_TYPE }],
                  // Required to replay reasoning items on later turns
                  // when running stateless — the API binds each
                  // web_search_call to its preceding reasoning item.
                  include: ['reasoning.encrypted_content' as const],
              }
            : {}),
        stream: true as const,
    };

    if (DEBUG_API_LOGGING) {
        console.log(LOG, '[debug] openai: → request', requestBody);
    }

    try {
        const stream = await client.responses.create(requestBody, { signal });

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
                    console.log(
                        LOG,
                        '[debug] openai: ← response',
                        event.response
                    );
                }
                const u = event.response.usage;
                if (u) {
                    usage = {
                        inputTokens: u.input_tokens,
                        outputTokens: u.output_tokens,
                    };
                }
                toolResults = buildOpenAIResponsesToolResults(event.response);
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
