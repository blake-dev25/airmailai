import Anthropic from '@anthropic-ai/sdk';
import type {
    AirmailAIChunk,
    AirmailAIMessage,
    AirmailAIMessageMetadata,
    AirmailAIToolName,
    ProviderStreamArgs,
} from '@airmailai/shared';
import {
    bytesToBase64,
    decodeBase64Text,
    hashBytes,
} from '../storage/encoding';
import { FILES_BETA } from './anthropic-files';
import { type ProviderReplicas, resolveAttachments } from './attachments';
import { makeDebugFetch } from './debug-fetch';
import { foldReplayIntoText } from './fold-replay';

const BUDGET_TOKENS: Record<Effort, number> = {
    low: 2048,
    medium: 8192,
    high: 16000,
    xhigh: 24000,
    max: 32000,
};

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

function mapStopReason(
    reason: string | null
): AirmailAIMessageMetadata['stopReason'] {
    if (reason === 'max_tokens') return 'length';
    if (reason === 'refusal') return 'refusal';
    return 'stop';
}

function serverToolName(name: string): AirmailAIToolName | undefined {
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

function readCodeExecFileIds(content: unknown): string[] {
    if (!content || typeof content !== 'object') return [];
    const inner = (content as { content?: unknown }).content;
    if (!Array.isArray(inner)) return [];
    const ids: string[] = [];
    for (const o of inner) {
        if (
            o &&
            typeof o === 'object' &&
            typeof (o as { file_id?: unknown }).file_id === 'string'
        ) {
            ids.push((o as { file_id: string }).file_id);
        }
    }
    return ids;
}

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

function attachmentBlock(
    mediaType: string,
    base64: string,
    filename: string
): Anthropic.Messages.ContentBlockParam {
    if (
        mediaType === 'image/jpeg' ||
        mediaType === 'image/png' ||
        mediaType === 'image/gif' ||
        mediaType === 'image/webp'
    ) {
        return {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64 },
        };
    }
    if (mediaType === 'application/pdf') {
        return {
            type: 'document',
            source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: base64,
            },
            title: filename,
            citations: { enabled: true },
        };
    }
    if (mediaType.startsWith('text/')) {
        return {
            type: 'document',
            source: {
                type: 'text',
                media_type: 'text/plain',
                data: decodeBase64Text(base64),
            },
            title: filename,
            citations: { enabled: true },
        };
    }
    throw new Error(`Anthropic does not support ${mediaType} attachments.`);
}

function isImageMedia(mediaType: string): boolean {
    return (
        mediaType === 'image/jpeg' ||
        mediaType === 'image/png' ||
        mediaType === 'image/gif' ||
        mediaType === 'image/webp'
    );
}

function providerFileBlock(
    mediaType: string,
    fileId: string,
    filename: string,
    isUser: boolean,
    codeExecEnabled: boolean
): Anthropic.Messages.ContentBlockParam {
    if (!isImageMedia(mediaType) && isUser && codeExecEnabled) {
        return { type: 'container_upload', file_id: fileId };
    }
    const block:
        | Anthropic.Beta.Messages.BetaImageBlockParam
        | Anthropic.Beta.Messages.BetaRequestDocumentBlock = isImageMedia(
        mediaType
    )
        ? { type: 'image', source: { type: 'file', file_id: fileId } }
        : {
              type: 'document',
              source: { type: 'file', file_id: fileId },
              title: filename,
              citations: { enabled: true },
          };
    return block as Anthropic.Messages.ContentBlockParam;
}

interface DocFile {
    hash: string;
    filename: string;
    mediaType: string;
}

function buildAttachmentBlocks(
    msg: AirmailAIMessage,
    blobs: Record<string, { mediaType: string; base64: string }>,
    codeExecEnabled: boolean,
    replicas: ProviderReplicas | undefined,
    docFiles: DocFile[]
): Anthropic.Messages.ContentBlockParam[] {
    const blocks: Anthropic.Messages.ContentBlockParam[] = [];
    for (const att of resolveAttachments(msg, blobs, replicas)) {
        if (att.kind === 'provider' && att.providerId !== 'anthropic') {
            continue;
        }
        const block =
            att.kind === 'provider'
                ? providerFileBlock(
                      att.mediaType,
                      att.fileId,
                      att.filename,
                      msg.role === 'user',
                      codeExecEnabled
                  )
                : attachmentBlock(att.mediaType, att.base64, att.filename);
        blocks.push(block);
        if (block.type === 'document') {
            docFiles.push({
                hash: att.hash,
                filename: att.filename,
                mediaType: att.mediaType,
            });
        }
    }
    return blocks;
}

function toAnthropicMessages(
    messages: AirmailAIMessage[],
    blobs: Record<string, { mediaType: string; base64: string }>,
    codeExecEnabled: boolean,
    replicas: ProviderReplicas | undefined,
    docFiles: DocFile[]
): Anthropic.Messages.MessageParam[] {
    return messages.map((msg) => {
        const text = foldReplayIntoText(msg);
        const blocks = buildAttachmentBlocks(
            msg,
            blobs,
            codeExecEnabled,
            replicas,
            docFiles
        );
        if (!blocks.length) return { role: msg.role, content: text };
        const content: Anthropic.Messages.ContentBlockParam[] = [];
        if (text) content.push({ type: 'text', text });
        content.push(...blocks);
        return { role: msg.role, content };
    });
}

export async function* streamAnthropic(
    args: ProviderStreamArgs
): AsyncGenerator<AirmailAIChunk> {
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

    if (thinkingEnabled && !adaptiveThinking && maxTokens < 2048) {
        throw new Error(
            'Thinking needs a 1024+ token budget plus room for the response. Raise max output tokens to at least 2048 or disable thinking.'
        );
    }

    const thinking: Anthropic.Messages.ThinkingConfigParam | undefined =
        thinkingEnabled
            ? adaptiveThinking
                ? { type: 'adaptive', display: 'summarized' }
                : {
                      type: 'enabled',
                      budget_tokens: Math.min(
                          BUDGET_TOKENS[thinkingLevel as Effort] ??
                              BUDGET_TOKENS.high,
                          Math.max(1024, maxTokens - 1024)
                      ),
                  }
            : undefined;

    const effort: Effort | undefined =
        thinkingEnabled &&
        adaptiveThinking &&
        (thinkingLevel === 'low' ||
            thinkingLevel === 'medium' ||
            thinkingLevel === 'high' ||
            thinkingLevel === 'xhigh' ||
            thinkingLevel === 'max')
            ? thinkingLevel
            : undefined;

    const wireTools = (args.params.tools ?? {}) as Record<
        string,
        string | boolean | undefined
    >;
    const tools: Anthropic.Messages.ToolUnion[] = [];
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
    const codeExecEnabled = typeof wireTools.codeExecution === 'string';
    if (codeExecEnabled) {
        tools.push({
            type: wireTools.codeExecution,
            name: 'code_execution',
        } as Anthropic.Messages.ToolUnion);
    }

    const replicas: ProviderReplicas | undefined =
        args.providerFiles && Object.keys(args.providerFiles).length
            ? { providerId: 'anthropic', files: args.providerFiles }
            : undefined;
    const needsFilesBeta = codeExecEnabled || !!replicas;
    const docFiles: DocFile[] = [];

    const stream = await client.messages.create(
        {
            model: args.model,
            max_tokens: maxTokens,
            messages: toAnthropicMessages(
                args.messages,
                args.blobs ?? {},
                codeExecEnabled,
                replicas,
                docFiles
            ),
            cache_control: { type: 'ephemeral' },
            ...(args.system ? { system: args.system } : {}),
            ...(args.params.temperature !== undefined
                ? { temperature: args.params.temperature as number }
                : {}),
            ...(thinking ? { thinking } : {}),
            ...(effort ? { output_config: { effort } } : {}),
            ...(tools.length ? { tools } : {}),
            ...(typeof args.params.container === 'string'
                ? { container: args.params.container }
                : {}),
            stream: true,
        },
        {
            signal: args.signal,
            ...(needsFilesBeta
                ? { headers: { 'anthropic-beta': FILES_BETA } }
                : {}),
        }
    );

    const openText = new Set<number>();
    const openReasoning = new Set<number>();
    const serverToolByIndex = new Map<
        number,
        { id: string; name: AirmailAIToolName; json: string }
    >();
    const seenSourceUrls = new Set<string>();
    const seenDocIndices = new Set<number>();
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: AirmailAIMessageMetadata['stopReason'];
    let containerId: string | undefined;
    let containerExpiresAt: string | undefined;

    try {
        for await (const event of stream) {
            switch (event.type) {
                case 'message_start': {
                    inputTokens = event.message.usage.input_tokens;
                    if (event.message.container) {
                        containerId = event.message.container.id;
                        containerExpiresAt = event.message.container.expires_at;
                    }
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
                            for (const r of content) {
                                if (r.type !== 'web_search_result') continue;
                                if (seenSourceUrls.has(r.url)) continue;
                                seenSourceUrls.add(r.url);
                                yield {
                                    type: 'source-url',
                                    sourceId: r.url,
                                    url: r.url,
                                    ...(r.title ? { title: r.title } : {}),
                                };
                            }
                        }
                        yield {
                            type: 'tool-result',
                            toolCallId: block.tool_use_id,
                        };
                    } else if (block.type === 'web_fetch_tool_result') {
                        const fetched = readWebFetchResult(block.content);
                        if (fetched && !seenSourceUrls.has(fetched.url)) {
                            seenSourceUrls.add(fetched.url);
                            yield {
                                type: 'source-url',
                                sourceId: fetched.url,
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
                        for (const fileId of readCodeExecFileIds(
                            block.content
                        )) {
                            const meta =
                                await client.beta.files.retrieveMetadata(
                                    fileId,
                                    { betas: [FILES_BETA] }
                                );
                            const resp = await client.beta.files.download(
                                fileId,
                                { betas: [FILES_BETA] }
                            );
                            const bytes = new Uint8Array(
                                await resp.arrayBuffer()
                            );
                            const hash = await hashBytes(bytes.buffer);
                            yield {
                                type: 'file',
                                filename: meta.filename,
                                mediaType: meta.mime_type,
                                sizeBytes: bytes.byteLength,
                                hash,
                                base64: bytesToBase64(bytes),
                                replicaFileId: fileId,
                            };
                        }
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
                    } else if (delta.type === 'input_json_delta') {
                        const pending = serverToolByIndex.get(event.index);
                        if (pending) pending.json += delta.partial_json;
                    } else if (delta.type === 'citations_delta') {
                        const c = delta.citation;
                        const textId = String(event.index);
                        if (
                            c.type === 'page_location' ||
                            c.type === 'char_location'
                        ) {
                            const sourceId = `doc:${c.document_index}`;
                            if (!seenDocIndices.has(c.document_index)) {
                                seenDocIndices.add(c.document_index);
                                const file = docFiles[c.document_index];
                                const title =
                                    file?.filename ?? c.document_title;
                                yield {
                                    type: 'source-document',
                                    sourceId,
                                    ...(title ? { title } : {}),
                                    mediaType:
                                        file?.mediaType ??
                                        (c.type === 'page_location'
                                            ? 'application/pdf'
                                            : 'text/plain'),
                                    ...(file ? { hash: file.hash } : {}),
                                };
                            }
                            yield {
                                type: 'citation',
                                sourceId,
                                textId,
                                citedText: c.cited_text,
                                location:
                                    c.type === 'page_location'
                                        ? {
                                              kind: 'page',
                                              start: c.start_page_number,
                                              end: c.end_page_number,
                                          }
                                        : {
                                              kind: 'char',
                                              start: c.start_char_index,
                                              end: c.end_char_index,
                                          },
                            };
                        } else if (c.type === 'web_search_result_location') {
                            if (!seenSourceUrls.has(c.url)) {
                                seenSourceUrls.add(c.url);
                                yield {
                                    type: 'source-url',
                                    sourceId: c.url,
                                    url: c.url,
                                    ...(c.title ? { title: c.title } : {}),
                                };
                            }
                            yield {
                                type: 'citation',
                                sourceId: c.url,
                                textId,
                                citedText: c.cited_text,
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
                        yield { type: 'reasoning-end', id };
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
                    if (event.delta.container) {
                        containerId = event.delta.container.id;
                        containerExpiresAt = event.delta.container.expires_at;
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
                        ...(containerId ? { containerId } : {}),
                        ...(containerExpiresAt ? { containerExpiresAt } : {}),
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
