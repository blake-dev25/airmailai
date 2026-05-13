import type {
    HydratedChatMessage,
    StreamHandlers,
    StreamUsage,
} from '@courier/shared';
import { OpenRouter } from '@openrouter/sdk';
import type {
    EasyInputMessage,
    EasyInputMessageContentInputImage,
    InputFile,
    InputText,
} from '@openrouter/sdk/models';
import { DEBUG_API_LOGGING } from '../debug';
import { collectUrlCitationSources, formatSources } from './sources';

const LOG = '[courier:ext]';

function toResponsesInput(msg: HydratedChatMessage): EasyInputMessage {
    if (!msg.attachments?.length) {
        return { role: msg.role as 'user' | 'assistant', content: msg.content };
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

    if (msg.content) {
        parts.push({ type: 'input_text', text: msg.content });
    }

    return { role: msg.role as 'user' | 'assistant', content: parts };
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
    const input = messages
        .filter((m) => m.role !== 'system')
        .map(toResponsesInput);

    const effort = toEffort(params.thinkingLevel as string | undefined);

    console.log(LOG, 'openrouter: stream start', {
        model,
        input: input.length,
        hasSystem: !!systemMsg,
        params,
    });

    try {
        const stream = await client.beta.responses.send(
            {
                responsesRequest: {
                    model,
                    input,
                    ...(systemMsg ? { instructions: systemMsg.content } : {}),
                    maxOutputTokens: (params.maxTokens as number) ?? 8192,
                    ...(params.temperature !== undefined
                        ? { temperature: params.temperature as number }
                        : {}),
                    ...(effort
                        ? { reasoning: { effort, summary: 'auto' } }
                        : {}),
                    ...(params.webSearch
                        ? { tools: [{ type: 'openrouter:web_search' }] }
                        : {}),
                    stream: true,
                },
            },
            { signal }
        );

        let firstChunk = true;
        let usage: StreamUsage | undefined;
        let sourceChunk = '';

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
                    console.log(LOG, '[debug] full response', event.response);
                }
                sourceChunk = formatSources(
                    collectUrlCitationSources(event.response)
                );
                const u = event.response.usage;
                if (u) {
                    usage = {
                        inputTokens: u.inputTokens ?? 0,
                        outputTokens: u.outputTokens ?? 0,
                    };
                }
            }
        }

        if (sourceChunk) handlers.onChunk(sourceChunk);
        console.log(LOG, 'openrouter: stream done');
        handlers.onDone(usage);
    } catch (e) {
        if (signal?.aborted) return;
        const msg = e instanceof Error ? e.message : String(e);
        console.error(LOG, 'openrouter: error', msg);
        handlers.onError(msg);
    }
}
