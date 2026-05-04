import Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage, StreamHandlers } from '@courier/shared';
import { DEBUG_API_LOGGING } from '../debug';

const LOG = '[courier:ext]';

function toAnthropicParam(msg: ChatMessage): Anthropic.MessageParam {
    if (!msg.attachments?.length) {
        return { role: msg.role as 'user' | 'assistant', content: msg.content };
    }

    const blocks: Anthropic.ContentBlockParam[] = [];

    for (const att of msg.attachments) {
        if (att.mediaType === 'application/pdf') {
            blocks.push({
                type: 'document',
                source: {
                    type: 'base64',
                    media_type: 'application/pdf',
                    data: att.data,
                },
            } as Anthropic.ContentBlockParam);
        } else {
            blocks.push({
                type: 'image',
                source: {
                    type: 'base64',
                    media_type: att.mediaType as
                        | 'image/jpeg'
                        | 'image/png'
                        | 'image/gif'
                        | 'image/webp',
                    data: att.data,
                },
            });
        }
    }

    if (msg.content) {
        blocks.push({ type: 'text', text: msg.content });
    }

    return { role: msg.role as 'user' | 'assistant', content: blocks };
}

export async function streamAnthropic(
    apiKey: string,
    model: string,
    messages: ChatMessage[],
    params: Record<string, unknown>,
    handlers: StreamHandlers,
    signal?: AbortSignal
): Promise<void> {
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

    const systemMsg = messages.find((m) => m.role === 'system');
    const chatMessages = messages
        .filter((m) => m.role !== 'system')
        .map(toAnthropicParam);

    console.log(LOG, 'anthropic: stream start', {
        model,
        chatMessages: chatMessages.length,
        hasSystem: !!systemMsg,
        params,
    });

    const thinkingLevel = params.thinkingLevel as string | undefined;
    const thinkingEnabled = thinkingLevel && thinkingLevel !== 'none';
    const adaptiveThinking =
        (params.adaptiveThinking as boolean | undefined) ?? true;

    // Manual-mode budget_tokens (only used when adaptiveThinking is false).
    // effort still drives depth; this is just the required cap for type: 'enabled'.
    const BUDGET_TOKENS: Record<string, number> = {
        low: 2048,
        medium: 8192,
        high: 16000,
        max: 32000,
    };

    const maxTokens = (params.maxTokens as number) ?? 8192;
    const thinkingParam = thinkingEnabled
        ? adaptiveThinking
            ? { thinking: { type: 'adaptive' } as never }
            : {
                  thinking: {
                      type: 'enabled',
                      // budget_tokens must be < max_tokens per Anthropic API
                      budget_tokens: Math.min(
                          BUDGET_TOKENS[thinkingLevel] ?? BUDGET_TOKENS.high,
                          Math.max(1024, maxTokens - 1024)
                      ),
                  } as never,
              }
        : {};

    try {
        const stream = client.messages.stream(
            {
                model,
                max_tokens: maxTokens,
                ...(params.temperature !== undefined
                    ? { temperature: params.temperature as number }
                    : {}),
                ...thinkingParam,
                ...(thinkingEnabled
                    ? { output_config: { effort: thinkingLevel } as never }
                    : {}),
                ...(systemMsg ? { system: systemMsg.content } : {}),
                messages: chatMessages,
            },
            { signal }
        );

        let firstChunk = true;
        for await (const event of stream) {
            if (event.type === 'content_block_delta') {
                const delta = event.delta as {
                    type: string;
                    text?: string;
                    thinking?: string;
                };
                if (delta.type === 'text_delta' && delta.text) {
                    if (firstChunk) {
                        console.log(LOG, 'anthropic: first chunk received');
                        firstChunk = false;
                    }
                    handlers.onChunk(delta.text);
                } else if (delta.type === 'thinking_delta' && delta.thinking) {
                    handlers.onThinking?.(delta.thinking);
                }
            }
        }

        console.log(LOG, 'anthropic: stream done');
        const finalMsg = await stream.finalMessage();
        if (DEBUG_API_LOGGING) {
            console.log(LOG, '[debug] full response', finalMsg);
        }
        const usage = finalMsg.usage
            ? {
                  inputTokens: finalMsg.usage.input_tokens,
                  outputTokens: finalMsg.usage.output_tokens,
              }
            : undefined;
        handlers.onDone(usage);
    } catch (e) {
        if (signal?.aborted) return;
        const msg = e instanceof Error ? e.message : String(e);
        console.error(LOG, 'anthropic: error', msg);
        handlers.onError(msg);
    }
}
