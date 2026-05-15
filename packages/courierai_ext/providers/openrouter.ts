import type {
    HydratedChatMessage,
    StreamHandlers,
    StreamUsage,
    WebSearchToolResult,
} from '@courier/shared';
import { OpenRouter } from '@openrouter/sdk';
import type {
    EasyInputMessage,
    EasyInputMessageContentInputImage,
    InputFile,
    InputsUnion,
    InputText,
} from '@openrouter/sdk/models';
import { DEBUG_API_LOGGING } from '../debug';
import { collectUrlCitationSources } from './tool-results';

const LOG = '[courier:ext]';

// OpenRouter normalizes/strips upstream encrypted search context on its
// Responses API passthrough — neither `encrypted_content` reasoning blobs
// nor `openrouter:web_search` action items survive in a way the model can
// re-derive URLs from. The only reliable carrier is plain text in the
// assistant turn. So for replay we append a markdown `Sources:` list to
// the stored assistant content with the URLs/titles we persisted.
// Verified vs an encrypted-content replay path (scripts/tool-call-test.ts):
// text-block lets both gpt-5.5-via-OR and Sonnet-via-OR print URLs verbatim;
// encrypted-content path refuses on both.
function withSourcesBlock(
    text: string,
    toolResults: WebSearchToolResult[]
): string {
    const lines: string[] = [];
    let n = 1;
    for (const tr of toolResults) {
        for (const s of tr.sources) {
            lines.push(
                s.title ? `${n}. [${s.title}](${s.url})` : `${n}. ${s.url}`
            );
            n++;
        }
    }
    if (!lines.length) return text;
    const block = 'Sources:\n' + lines.join('\n');
    return text ? `${text}\n\n${block}` : block;
}

function messageInputItem(msg: HydratedChatMessage): EasyInputMessage {
    const content =
        msg.role === 'assistant' && msg.toolResults?.length
            ? withSourcesBlock(msg.content, msg.toolResults)
            : msg.content;

    if (!msg.attachments?.length) {
        return { role: msg.role as 'user' | 'assistant', content };
    }

    const parts: Array<
        InputText | EasyInputMessageContentInputImage | InputFile
    > = [];

    for (const att of msg.attachments) {
        if (att.mediaType.startsWith('image/')) {
            parts.push({
                type: 'input_image',
                imageUrl: `data:${att.mediaType};base64,${att.data}`,
                detail: 'auto',
            });
        } else {
            parts.push({
                type: 'input_file',
                filename: att.name,
                fileData: `data:${att.mediaType};base64,${att.data}`,
            });
        }
    }

    if (content) {
        parts.push({ type: 'input_text', text: content });
    }

    return { role: msg.role as 'user' | 'assistant', content: parts };
}

function toResponsesInput(
    messages: HydratedChatMessage[]
): Exclude<InputsUnion, string> {
    return messages.map(messageInputItem);
}

// Our thinkingLevel vocabulary → OpenRouter's reasoning.effort enum.
// 'max' has no equivalent and clamps to 'high'.
function toEffort(
    level: string | undefined
): 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | undefined {
    if (!level || level === 'none') return undefined;
    if (level === 'max') return 'high';
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

export async function streamOpenRouter(
    apiKey: string,
    model: string,
    messages: HydratedChatMessage[],
    params: Record<string, unknown>,
    handlers: StreamHandlers,
    signal?: AbortSignal
): Promise<void> {
    const client = new OpenRouter({
        apiKey,
        ...(params.tagOpenRouterRequests
            ? { appTitle: 'CourierAI', httpReferer: 'https://courierai.net' }
            : {}),
    });

    const systemMsg = messages.find((m) => m.role === 'system');
    const input = toResponsesInput(messages.filter((m) => m.role !== 'system'));

    const effort = toEffort(params.thinkingLevel as string | undefined);

    console.log(LOG, 'openrouter: stream start', {
        model,
        input: input.length,
        hasSystem: !!systemMsg,
        params,
    });

    const requestBody = {
        responsesRequest: {
            model,
            input,
            ...(systemMsg ? { instructions: systemMsg.content } : {}),
            maxOutputTokens: (params.maxTokens as number) ?? 8192,
            ...(params.temperature !== undefined
                ? { temperature: params.temperature as number }
                : {}),
            ...(effort
                ? { reasoning: { effort, summary: 'auto' as const } }
                : {}),
            ...(params.webSearch
                ? { tools: [{ type: 'openrouter:web_search' as const }] }
                : {}),
            stream: true as const,
        },
    };

    if (DEBUG_API_LOGGING) {
        console.log(LOG, '[debug] openrouter: → request', requestBody);
    }

    try {
        const stream = await client.beta.responses.send(requestBody, {
            signal,
        });

        let firstChunk = true;
        let usage: StreamUsage | undefined;
        let toolResults: WebSearchToolResult[] = [];

        for await (const event of stream) {
            if (event.type === 'response.output_text.delta') {
                if (firstChunk) {
                    console.log(LOG, 'openrouter: first chunk received');
                    firstChunk = false;
                }
                handlers.onChunk(event.delta);
            } else if (event.type === 'response.reasoning_summary_text.delta') {
                handlers.onThinking?.(event.delta);
            } else if (event.type === 'response.completed') {
                if (DEBUG_API_LOGGING) {
                    console.log(
                        LOG,
                        '[debug] openrouter: ← response',
                        event.response
                    );
                }
                const sources = collectUrlCitationSources(event.response);
                toolResults = sources.length
                    ? [{ type: 'web_search', sources }]
                    : [];
                const u = event.response.usage;
                if (u) {
                    usage = {
                        inputTokens: u.inputTokens ?? 0,
                        outputTokens: u.outputTokens ?? 0,
                    };
                }
            }
        }

        if (toolResults.length) handlers.onToolResults?.(toolResults);
        console.log(LOG, 'openrouter: stream done');
        handlers.onDone(usage);
    } catch (e) {
        if (signal?.aborted) return;
        const msg = e instanceof Error ? e.message : String(e);
        console.error(LOG, 'openrouter: error', msg);
        handlers.onError(msg);
    }
}
