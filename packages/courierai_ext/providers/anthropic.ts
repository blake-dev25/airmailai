import Anthropic from '@anthropic-ai/sdk';
import type { HydratedChatMessage, StreamHandlers } from '@courier/shared';
import { DEBUG_API_LOGGING } from '../debug';
import { formatSources, type SourceLink } from './sources';

const LOG = '[courier:ext]';

function decodeBase64Utf8(data: string): string {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
}

function toAnthropicParam(msg: HydratedChatMessage): Anthropic.MessageParam {
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
            });
        } else if (att.mediaType === 'text/plain') {
            blocks.push({
                type: 'document',
                source: {
                    type: 'text',
                    media_type: 'text/plain',
                    data: decodeBase64Utf8(att.data),
                },
            });
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

function addAnthropicCitation(sources: SourceLink[], citation: unknown): void {
    if (!citation || typeof citation !== 'object') return;
    const candidate = citation as {
        title?: unknown;
        type?: unknown;
        url?: unknown;
    };
    if (
        candidate.type === 'web_search_result_location' &&
        typeof candidate.url === 'string'
    ) {
        sources.push({
            url: candidate.url,
            title:
                typeof candidate.title === 'string'
                    ? candidate.title
                    : undefined,
        });
    }
}

function collectAnthropicSources(message: unknown): SourceLink[] {
    if (!message || typeof message !== 'object') return [];
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return [];

    const sources: SourceLink[] = [];
    for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const candidate = block as {
            citations?: unknown;
            content?: unknown;
            title?: unknown;
            type?: unknown;
            url?: unknown;
        };

        if (Array.isArray(candidate.citations)) {
            for (const citation of candidate.citations) {
                addAnthropicCitation(sources, citation);
            }
        }

        if (
            candidate.type === 'web_search_tool_result' &&
            Array.isArray(candidate.content)
        ) {
            for (const item of candidate.content) {
                if (!item || typeof item !== 'object') continue;
                const result = item as {
                    title?: unknown;
                    type?: unknown;
                    url?: unknown;
                };
                if (
                    result.type === 'web_search_result' &&
                    typeof result.url === 'string'
                ) {
                    sources.push({
                        url: result.url,
                        title:
                            typeof result.title === 'string'
                                ? result.title
                                : undefined,
                    });
                }
            }
        }
    }

    return sources;
}

export async function streamAnthropic(
    apiKey: string,
    model: string,
    messages: HydratedChatMessage[],
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
    const webSearchParam = params.webSearch
        ? {
              tools: [
                  {
                      type: 'web_search_20260209',
                      name: 'web_search',
                      max_uses: 5,
                  } as never,
              ],
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
                ...webSearchParam,
                ...(systemMsg ? { system: systemMsg.content } : {}),
                messages: chatMessages,
            },
            { signal }
        );

        let firstChunk = true;
        for await (const event of stream) {
            if (event.type === 'content_block_delta') {
                const delta = event.delta;
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
        const sourceChunk = formatSources(collectAnthropicSources(finalMsg));
        if (sourceChunk) handlers.onChunk(sourceChunk);
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
