import type { ChatMessage, StreamHandlers, StreamUsage } from '@courier/shared';
import { OpenRouter } from '@openrouter/sdk';
import { DEBUG_API_LOGGING } from '../debug';

const LOG = '[courier:ext]';

type EasyInputContent =
    | { type: 'input_text'; text: string }
    | { type: 'input_image'; imageUrl: string; detail: 'auto' }
    | { type: 'input_file'; filename: string; fileData: string };

function toResponsesInput(msg: ChatMessage): {
    role: 'user' | 'assistant';
    content: string | EasyInputContent[];
} {
    if (!msg.attachments?.length) {
        return { role: msg.role as 'user' | 'assistant', content: msg.content };
    }

    const parts: EasyInputContent[] = [];

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
    messages: ChatMessage[],
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
                    input: input as never,
                    ...(systemMsg ? { instructions: systemMsg.content } : {}),
                    maxOutputTokens: (params.maxTokens as number) ?? 8192,
                    ...(params.temperature !== undefined
                        ? { temperature: params.temperature as number }
                        : {}),
                    ...(effort
                        ? { reasoning: { effort, summary: 'auto' } }
                        : {}),
                    stream: true,
                },
            },
            { signal }
        );

        let firstChunk = true;
        let usage: StreamUsage | undefined;

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
                const u = event.response.usage;
                if (u) {
                    usage = {
                        inputTokens: u.inputTokens ?? 0,
                        outputTokens: u.outputTokens ?? 0,
                    };
                }
            }
        }

        console.log(LOG, 'openrouter: stream done');
        handlers.onDone(usage);
    } catch (e) {
        if (signal?.aborted) return;
        const msg = e instanceof Error ? e.message : String(e);
        console.error(LOG, 'openrouter: error', msg);
        handlers.onError(msg);
    }
}
