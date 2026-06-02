import Anthropic from '@anthropic-ai/sdk';
import type {
    CourierAIChunk,
    CourierAIMessage,
    CourierAIMessageMetadata,
    CourierAISourceUrlPart,
    CourierAIToolName,
    ProviderStreamArgs,
} from '@courierai/shared';
import { makeDebugFetch } from './debug-fetch';

// Manual-mode budget_tokens (only used when adaptiveThinking is false). `effort`
// drives depth on Opus 4.7+; older models take depth from the budget itself.
const BUDGET_TOKENS: Record<string, number> = {
    low: 2048,
    medium: 8192,
    high: 16000,
    max: 32000,
};

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

function mapStopReason(
    reason: string | null
): CourierAIMessageMetadata['stopReason'] {
    if (reason === 'max_tokens') return 'length';
    if (reason === 'refusal') return 'refusal';
    return 'stop';
}

// code_execution_20260120 reports code execution as bash_/text_editor_ sub-tools;
// collapse them (and the legacy code_execution name) onto our single
// code_execution tool. Returns undefined for server tools we don't surface.
function serverToolName(name: string): CourierAIToolName | undefined {
    if (name === 'web_search' || name === 'web_fetch') return name;
    if (
        name === 'code_execution' ||
        name === 'bash_code_execution' ||
        name === 'text_editor_code_execution'
    ) {
        return 'code_execution';
    }
    return undefined;
}

// web_fetch / code_execution result blocks nest any failure in `content` as a
// *_tool_result_error carrying an error_code. Surface it instead of dropping it.
function toolResultError(content: unknown): string | undefined {
    if (
        content &&
        typeof content === 'object' &&
        'type' in content &&
        typeof (content as { type: unknown }).type === 'string' &&
        (content as { type: string }).type.endsWith('_tool_result_error')
    ) {
        const code = (content as { error_code?: unknown }).error_code;
        return typeof code === 'string' ? code : 'tool execution error';
    }
    return undefined;
}

// web_fetch_tool_result content: { type:'web_fetch_result', url, content:{ title? } }.
function readWebFetchResult(
    content: unknown
): { url: string; title?: string } | undefined {
    if (
        !content ||
        typeof content !== 'object' ||
        (content as { type?: unknown }).type !== 'web_fetch_result'
    ) {
        return undefined;
    }
    const url = (content as { url?: unknown }).url;
    if (typeof url !== 'string') return undefined;
    const inner = (content as { content?: { title?: unknown } }).content;
    const title = inner?.title;
    return {
        url,
        ...(typeof title === 'string' ? { title } : {}),
    };
}

// *_code_execution_result content carries stdout/stderr; surface both (stderr
// matters for the never-silence-errors rule).
function readCodeExecOutput(
    content: unknown
): { stdout?: string; stderr?: string } | undefined {
    if (!content || typeof content !== 'object') return undefined;
    const o = content as { stdout?: unknown; stderr?: unknown };
    const out: { stdout?: string; stderr?: string } = {};
    if (typeof o.stdout === 'string' && o.stdout) out.stdout = o.stdout;
    if (typeof o.stderr === 'string' && o.stderr) out.stderr = o.stderr;
    return out.stdout || out.stderr ? out : undefined;
}

// Server-tool input arrives as streamed JSON; pull the bash command / code body.
function parseCodeCommand(json: string): string | undefined {
    if (!json) return undefined;
    let raw: unknown;
    try {
        raw = JSON.parse(json);
    } catch {
        return undefined;
    }
    if (raw && typeof raw === 'object') {
        const o = raw as { command?: unknown; code?: unknown };
        const v = typeof o.command === 'string' ? o.command : o.code;
        if (typeof v === 'string') return v;
    }
    return undefined;
}

// Replay token Anthropic stashes on a source-url part so the result round-trips
// natively (no text fold). Set when this provider produced the part.
function readAnthropicMeta(part: CourierAISourceUrlPart): {
    toolUseId?: string;
    encryptedContent?: string;
} {
    const a = part.providerMetadata?.anthropic;
    return {
        toolUseId: typeof a?.toolUseId === 'string' ? a.toolUseId : undefined,
        encryptedContent:
            typeof a?.encryptedContent === 'string'
                ? a.encryptedContent
                : undefined,
    };
}

// Anthropic round-trips web search NATIVELY: rebuild the server_tool_use +
// web_search_tool_result blocks from the source-url parts we captured (grouped
// by tool_use_id), then the assistant text. No Sources text-fold. Parts from a
// different provider (no anthropic metadata) are skipped here.
function toContent(
    msg: CourierAIMessage
): string | Anthropic.Messages.ContentBlockParam[] {
    let text = '';
    const byToolUse = new Map<string, CourierAISourceUrlPart[]>();
    for (const part of msg.parts) {
        if (part.type === 'text') {
            text += part.text;
        } else if (part.type === 'source-url') {
            const { toolUseId } = readAnthropicMeta(part);
            if (toolUseId) {
                const arr = byToolUse.get(toolUseId) ?? [];
                arr.push(part);
                byToolUse.set(toolUseId, arr);
            }
        }
    }
    // TODO: hydrate data-attachment parts into document/image blocks.
    if (byToolUse.size === 0) return text;

    const blocks: Anthropic.Messages.ContentBlockParam[] = [];
    for (const [toolUseId, sources] of byToolUse) {
        blocks.push({
            type: 'server_tool_use',
            id: toolUseId,
            name: 'web_search',
            input: { query: '' },
        });
        blocks.push({
            type: 'web_search_tool_result',
            tool_use_id: toolUseId,
            content: sources.map((s) => ({
                type: 'web_search_result' as const,
                url: s.url,
                title: s.title ?? s.url,
                encrypted_content: readAnthropicMeta(s).encryptedContent ?? '',
            })),
        });
    }
    if (text) blocks.push({ type: 'text', text });
    return blocks;
}

function toAnthropicMessages(
    messages: CourierAIMessage[]
): Anthropic.Messages.MessageParam[] {
    return messages.map((msg) => ({ role: msg.role, content: toContent(msg) }));
}

// Hand-rolled Anthropic Messages provider. Maps the content-block SSE to our
// chunk vocabulary. Web search round-trips natively via toContent (no fold);
// thinking signatures are captured into reasoning-end providerMetadata so
// extended thinking can replay. See ai_sdk_removal_plan.txt D4.
export async function* streamAnthropic(
    args: ProviderStreamArgs
): AsyncGenerator<CourierAIChunk> {
    // dangerouslyAllowBrowser sets `anthropic-dangerous-direct-browser-access`,
    // required to skip the CORS preflight from an MV3 service worker.
    const client = new Anthropic({
        apiKey: args.apiKey,
        dangerouslyAllowBrowser: true,
        fetch: makeDebugFetch('anthropic'),
    });

    const thinkingLevel = args.params.thinkingLevel as string | undefined;
    const thinkingEnabled = !!thinkingLevel && thinkingLevel !== 'none';
    const adaptiveThinking =
        (args.params.adaptiveThinking as boolean | undefined) ?? true;
    const maxTokens = (args.params.maxTokens as number | undefined) ?? 8192;

    const thinking: Anthropic.Messages.ThinkingConfigParam | undefined =
        thinkingEnabled
            ? adaptiveThinking
                ? { type: 'adaptive' }
                : {
                      type: 'enabled',
                      // budget_tokens must be >=1024 and < max_tokens.
                      budget_tokens: Math.min(
                          BUDGET_TOKENS[thinkingLevel] ?? BUDGET_TOKENS.high,
                          Math.max(1024, maxTokens - 1024)
                      ),
                  }
            : undefined;

    // effort is an Opus 4.7+ knob; older models ignore it. 'max' is valid in
    // OutputConfig.effort, so no clamping (unlike OpenAI).
    const effort: Effort | undefined =
        thinkingEnabled &&
        (thinkingLevel === 'low' ||
            thinkingLevel === 'medium' ||
            thinkingLevel === 'high' ||
            thinkingLevel === 'xhigh' ||
            thinkingLevel === 'max')
            ? thinkingLevel
            : undefined;

    // The web sends the versioned tool TYPE per model (e.g. web_search_20260209)
    // so the version map stays in the website. The dynamic string can't satisfy
    // a specific literal tool type, so cast at this trusted-wire boundary.
    const wireTools = (args.params.tools ?? {}) as Record<
        string,
        string | boolean | undefined
    >;
    const tools: Anthropic.Messages.ToolUnion[] = [];
    // allowed_callers: ['direct'] forces the model to call web tools directly
    // rather than through programmatic tool calling (the _20260209 default),
    // which otherwise wraps each fetch/search in a code-execution REPL. Direct
    // is cheaper, faster, and keeps web results out of the Code surface (they
    // show as Sources). Accepted on every tool version.
    if (typeof wireTools.webSearch === 'string') {
        tools.push({
            type: wireTools.webSearch,
            name: 'web_search',
            max_uses: 5,
            allowed_callers: ['direct'],
        } as Anthropic.Messages.ToolUnion);
    }
    if (typeof wireTools.webFetch === 'string') {
        tools.push({
            type: wireTools.webFetch,
            name: 'web_fetch',
            max_uses: 5,
            allowed_callers: ['direct'],
        } as Anthropic.Messages.ToolUnion);
    }
    if (typeof wireTools.codeExecution === 'string') {
        tools.push({
            type: wireTools.codeExecution,
            name: 'code_execution',
        } as Anthropic.Messages.ToolUnion);
    }

    const stream = await client.messages.create(
        {
            model: args.model,
            max_tokens: maxTokens,
            messages: toAnthropicMessages(args.messages),
            ...(args.system ? { system: args.system } : {}),
            ...(args.params.temperature !== undefined
                ? { temperature: args.params.temperature as number }
                : {}),
            ...(thinking ? { thinking } : {}),
            ...(effort ? { output_config: { effort } } : {}),
            ...(tools.length ? { tools } : {}),
            stream: true,
        },
        { signal: args.signal }
    );

    // Anthropic indexes content blocks (0,1,2...). Use the index as the part id
    // to bracket text/reasoning; signatures arrive as their own delta and land
    // on reasoning-end.
    const openText = new Set<number>();
    const openReasoning = new Set<number>();
    const signatureByIndex = new Map<number, string>();
    // Server-tool input streams as input_json_delta; accumulate it per block
    // index and emit the tool-call at content_block_stop with the parsed input.
    // (Web tools run direct - allowed_callers above - so there's no programmatic
    // code-execution wrapper to untangle; every code_execution block is genuine.)
    const serverToolByIndex = new Map<
        number,
        { id: string; name: CourierAIToolName; json: string }
    >();
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: CourierAIMessageMetadata['stopReason'];

    try {
        for await (const event of stream) {
            switch (event.type) {
                case 'message_start': {
                    inputTokens = event.message.usage.input_tokens;
                    break;
                }
                case 'content_block_start': {
                    const block = event.content_block;
                    const id = String(event.index);
                    if (block.type === 'text') {
                        openText.add(event.index);
                        yield { type: 'text-start', id };
                    } else if (block.type === 'thinking') {
                        openReasoning.add(event.index);
                        yield { type: 'reasoning-start', id };
                    } else if (block.type === 'server_tool_use') {
                        // Record for input accumulation; the tool-call is emitted
                        // at content_block_stop once the input JSON is complete.
                        const name = serverToolName(block.name);
                        if (name) {
                            serverToolByIndex.set(event.index, {
                                id: block.id,
                                name,
                                json: '',
                            });
                        }
                    } else if (block.type === 'web_search_tool_result') {
                        const content = block.content;
                        if (Array.isArray(content)) {
                            for (let i = 0; i < content.length; i++) {
                                const r = content[i];
                                if (r.type !== 'web_search_result') continue;
                                yield {
                                    type: 'source-url',
                                    sourceId: `${block.tool_use_id}:${i}`,
                                    url: r.url,
                                    ...(r.title ? { title: r.title } : {}),
                                    providerMetadata: {
                                        anthropic: {
                                            toolUseId: block.tool_use_id,
                                            encryptedContent:
                                                r.encrypted_content,
                                        },
                                    },
                                };
                            }
                        }
                        yield {
                            type: 'tool-result',
                            toolCallId: block.tool_use_id,
                        };
                    } else if (block.type === 'web_fetch_tool_result') {
                        // Surface the fetched page as a source so it shows in the
                        // Sources block (no providerMetadata: display-only, not
                        // replayed natively like web_search).
                        const fetched = readWebFetchResult(block.content);
                        if (fetched) {
                            yield {
                                type: 'source-url',
                                sourceId: `${block.tool_use_id}:fetch`,
                                url: fetched.url,
                                ...(fetched.title
                                    ? { title: fetched.title }
                                    : {}),
                            };
                        }
                        const errorText = toolResultError(block.content);
                        yield {
                            type: 'tool-result',
                            toolCallId: block.tool_use_id,
                            ...(errorText ? { errorText } : {}),
                        };
                    } else if (
                        block.type === 'code_execution_tool_result' ||
                        block.type === 'bash_code_execution_tool_result' ||
                        block.type === 'text_editor_code_execution_tool_result'
                    ) {
                        const errorText = toolResultError(block.content);
                        const output = readCodeExecOutput(block.content);
                        yield {
                            type: 'tool-result',
                            toolCallId: block.tool_use_id,
                            ...(output ? { output } : {}),
                            ...(errorText ? { errorText } : {}),
                        };
                    }
                    break;
                }
                case 'content_block_delta': {
                    const id = String(event.index);
                    const delta = event.delta;
                    if (delta.type === 'text_delta') {
                        yield { type: 'text-delta', id, delta: delta.text };
                    } else if (delta.type === 'thinking_delta') {
                        yield {
                            type: 'reasoning-delta',
                            id,
                            delta: delta.thinking,
                        };
                    } else if (delta.type === 'signature_delta') {
                        signatureByIndex.set(event.index, delta.signature);
                    } else if (delta.type === 'input_json_delta') {
                        const pending = serverToolByIndex.get(event.index);
                        if (pending) pending.json += delta.partial_json;
                    } else if (delta.type === 'citations_delta') {
                        const c = delta.citation;
                        if (c.type === 'page_location') {
                            yield {
                                type: 'source-document',
                                sourceId: `${event.index}:page:${c.start_page_number}`,
                                ...(c.document_title
                                    ? { title: c.document_title }
                                    : {}),
                                citedText: c.cited_text,
                                location: {
                                    kind: 'page',
                                    start: c.start_page_number,
                                    end: c.end_page_number,
                                },
                            };
                        } else if (c.type === 'char_location') {
                            yield {
                                type: 'source-document',
                                sourceId: `${event.index}:char:${c.start_char_index}`,
                                ...(c.document_title
                                    ? { title: c.document_title }
                                    : {}),
                                citedText: c.cited_text,
                                location: {
                                    kind: 'char',
                                    start: c.start_char_index,
                                    end: c.end_char_index,
                                },
                            };
                        }
                    }
                    break;
                }
                case 'content_block_stop': {
                    const id = String(event.index);
                    if (openText.delete(event.index)) {
                        yield { type: 'text-end', id };
                    } else if (openReasoning.delete(event.index)) {
                        const signature = signatureByIndex.get(event.index);
                        yield {
                            type: 'reasoning-end',
                            id,
                            ...(signature
                                ? {
                                      providerMetadata: {
                                          anthropic: { signature },
                                      },
                                  }
                                : {}),
                        };
                    } else {
                        const pending = serverToolByIndex.get(event.index);
                        if (pending) {
                            serverToolByIndex.delete(event.index);
                            if (pending.name === 'code_execution') {
                                const code = parseCodeCommand(pending.json);
                                yield {
                                    type: 'tool-call',
                                    toolCallId: pending.id,
                                    name: 'code_execution',
                                    ...(code ? { input: { code } } : {}),
                                };
                            } else {
                                yield {
                                    type: 'tool-call',
                                    toolCallId: pending.id,
                                    name: pending.name,
                                };
                            }
                        }
                    }
                    break;
                }
                case 'message_delta': {
                    if (event.usage?.output_tokens != null) {
                        outputTokens = event.usage.output_tokens;
                    }
                    if (event.delta.stop_reason) {
                        stopReason = mapStopReason(event.delta.stop_reason);
                    }
                    break;
                }
                case 'message_stop': {
                    yield {
                        type: 'finish',
                        metadata: {
                            tokens: {
                                input: inputTokens,
                                output: outputTokens,
                            },
                            ...(stopReason ? { stopReason } : {}),
                        },
                    };
                    break;
                }
            }
        }
    } catch (e) {
        if (args.signal?.aborted) return;
        throw e;
    }
}
