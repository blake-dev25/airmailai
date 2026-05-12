import type {
    HydratedChatMessage,
    StreamHandlers,
    StreamUsage,
} from '@courier/shared';
import OpenAI from 'openai';
import { DEBUG_API_LOGGING } from '../debug';

const LOG = '[courier:ext]';

function toOpenAIParam(
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
    const inputMessages = messages
        .filter((m) => m.role !== 'system')
        .map(toOpenAIParam);

    const thinkingLevel = params.thinkingLevel as string | undefined;
    const thinkingEnabled = thinkingLevel && thinkingLevel !== 'none';

    console.log(LOG, 'openai: stream start', {
        model,
        inputMessages: inputMessages.length,
        hasSystem: !!systemMsg,
        params,
    });

    try {
        const stream = await client.responses.create(
            {
                model,
                input: inputMessages,
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
                stream: true,
            },
            { signal }
        );

        let firstChunk = true;
        let usage: StreamUsage | undefined;

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
            }
        }

        console.log(LOG, 'openai: stream done');
        handlers.onDone(usage);
    } catch (e) {
        if (signal?.aborted) return;
        const msg = e instanceof Error ? e.message : String(e);
        console.error(LOG, 'openai: error', msg);
        handlers.onError(msg);
    }
}
