import Anthropic from '@anthropic-ai/sdk';
import type {
    HydratedChatMessage,
    StreamHandlers,
    WebSearchToolResult,
} from '@courier/shared';
import { DEBUG_API_LOGGING } from '../debug';

const LOG = '[courier:ext]';

function decodeBase64Utf8(data: string): string {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
}

function attachmentBlocks(
    msg: HydratedChatMessage
): Anthropic.ContentBlockParam[] {
    const blocks: Anthropic.ContentBlockParam[] = [];
    for (const att of msg.attachments ?? []) {
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
    return blocks;
}

// Reconstruct a previous turn's `server_tool_use` + `web_search_tool_result`
// pair from a stored ToolResult. Each WebSearchResultBlockParam requires
// `encrypted_content` and `title` per the SDK types — we fall back to empty
// string / url to keep the call shape valid even if the original encrypted
// blob wasn't captured.
function toolResultBlocks(
    toolResults: WebSearchToolResult[]
): Anthropic.ContentBlockParam[] {
    const blocks: Anthropic.ContentBlockParam[] = [];
    for (const tr of toolResults) {
        if (!tr.callId) continue; // Anthropic requires id linkage; skip otherwise.
        blocks.push({
            type: 'server_tool_use',
            id: tr.callId,
            name: 'web_search',
            input: { query: '' },
        });
        blocks.push({
            type: 'web_search_tool_result',
            tool_use_id: tr.callId,
            content: tr.sources.map((s) => ({
                type: 'web_search_result',
                url: s.url,
                title: s.title ?? s.url,
                encrypted_content: s.anthropicEncrypted ?? '',
            })),
        });
    }
    return blocks;
}

function toAnthropicParam(msg: HydratedChatMessage): Anthropic.MessageParam {
    const role = msg.role as 'user' | 'assistant';

    const hasAttachments = !!msg.attachments?.length;
    const hasToolResults = role === 'assistant' && !!msg.toolResults?.length;

    if (!hasAttachments && !hasToolResults) {
        return { role, content: msg.content };
    }

    const blocks: Anthropic.ContentBlockParam[] = [];
    if (hasAttachments) {
        blocks.push(...attachmentBlocks(msg));
    }
    if (hasToolResults) {
        blocks.push(...toolResultBlocks(msg.toolResults!));
    }
    if (msg.content) {
        blocks.push({ type: 'text', text: msg.content });
    }

    return { role, content: blocks };
}

// Walk the final assistant message and group each `server_tool_use` with its
// matching `web_search_tool_result` block by `tool_use_id`. Each pair becomes
// one stored ToolResult so we can reconstruct it on the next turn.
function collectAnthropicToolResults(message: unknown): WebSearchToolResult[] {
    if (!message || typeof message !== 'object') return [];
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return [];

    const callIds: string[] = [];
    const resultsByCallId = new Map<string, WebSearchToolResult>();

    for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as {
            type?: unknown;
            id?: unknown;
            name?: unknown;
            tool_use_id?: unknown;
            content?: unknown;
        };

        if (
            b.type === 'server_tool_use' &&
            b.name === 'web_search' &&
            typeof b.id === 'string'
        ) {
            callIds.push(b.id);
            if (!resultsByCallId.has(b.id)) {
                resultsByCallId.set(b.id, {
                    type: 'web_search',
                    callId: b.id,
                    sources: [],
                });
            }
            continue;
        }

        if (
            b.type === 'web_search_tool_result' &&
            typeof b.tool_use_id === 'string' &&
            Array.isArray(b.content)
        ) {
            const tr = resultsByCallId.get(b.tool_use_id) ?? {
                type: 'web_search' as const,
                callId: b.tool_use_id,
                sources: [],
            };
            for (const item of b.content) {
                if (!item || typeof item !== 'object') continue;
                const r = item as {
                    type?: unknown;
                    url?: unknown;
                    title?: unknown;
                    encrypted_content?: unknown;
                };
                if (
                    r.type === 'web_search_result' &&
                    typeof r.url === 'string'
                ) {
                    tr.sources.push({
                        url: r.url,
                        ...(typeof r.title === 'string'
                            ? { title: r.title }
                            : {}),
                        ...(typeof r.encrypted_content === 'string'
                            ? { anthropicEncrypted: r.encrypted_content }
                            : {}),
                    });
                }
            }
            if (!resultsByCallId.has(b.tool_use_id)) {
                callIds.push(b.tool_use_id);
                resultsByCallId.set(b.tool_use_id, tr);
            }
        }
    }

    return callIds
        .map((id) => resultsByCallId.get(id))
        .filter(
            (tr): tr is WebSearchToolResult => !!tr && tr.sources.length > 0
        );
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
            ? { thinking: { type: 'adaptive' as const } }
            : {
                  thinking: {
                      type: 'enabled' as const,
                      // budget_tokens must be < max_tokens per Anthropic API
                      budget_tokens: Math.min(
                          BUDGET_TOKENS[thinkingLevel] ?? BUDGET_TOKENS.high,
                          Math.max(1024, maxTokens - 1024)
                      ),
                  },
              }
        : {};
    const webSearchParam = params.webSearch
        ? {
              tools: [
                  {
                      type: 'web_search_20260209',
                      name: 'web_search',
                      max_uses: 5,
                  } satisfies Anthropic.Messages.WebSearchTool20260209,
              ],
          }
        : {};

    const requestBody = {
        model,
        max_tokens: maxTokens,
        ...(params.temperature !== undefined
            ? { temperature: params.temperature as number }
            : {}),
        ...thinkingParam,
        ...(thinkingEnabled
            ? {
                  output_config: {
                      effort: thinkingLevel as Anthropic.Messages.OutputConfig['effort'],
                  },
              }
            : {}),
        ...webSearchParam,
        ...(systemMsg ? { system: systemMsg.content } : {}),
        messages: chatMessages,
    };

    if (DEBUG_API_LOGGING) {
        console.log(LOG, '[debug] anthropic: → request', requestBody);
    }

    try {
        const stream = client.messages.stream(requestBody, { signal });

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
            console.log(LOG, '[debug] anthropic: ← response', finalMsg);
        }
        const toolResults = collectAnthropicToolResults(finalMsg);
        if (toolResults.length) handlers.onToolResults?.(toolResults);
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
