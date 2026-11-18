import { HTTPClient, OpenRouter } from '@openrouter/sdk';
import { EventStream } from '@openrouter/sdk/lib/event-streams.js';
import type {
    EasyInputMessageContentUnion1,
    FileParserPlugin,
    OpenResponsesResult,
    OutputShellServerToolItem,
    ShellServerToolEnvironment,
    ShellServerToolOpenRouter,
} from '@openrouter/sdk/models';
import type {
    AirmailAIChunk,
    AirmailAIMessage,
    AirmailAIMessageMetadata,
    ProviderStreamArgs,
} from '@airmailai/shared';
import { getMimeTypeFromFilename, isTextMimeType } from '@airmailai/shared';
import { type ProviderReplicas, resolveAttachments } from './attachments';
import { makeModelFetch } from './custom-model';
import { foldReplayIntoText } from './fold-replay';
import {
    bytesToBase64,
    decodeBase64Text,
    hashBytes,
} from '../storage/encoding';

type Effort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

type ReasoningConfig = { effort: Effort; summary: 'auto' } | { enabled: false };

function toReasoning(level: string | undefined): ReasoningConfig | undefined {
    if (!level) return undefined;
    if (level === 'none') return { enabled: false };
    if (
        level === 'minimal' ||
        level === 'low' ||
        level === 'medium' ||
        level === 'high' ||
        level === 'xhigh' ||
        level === 'max'
    ) {
        return { effort: level, summary: 'auto' };
    }
    return undefined;
}

function audioFormat(mediaType: string): 'mp3' | 'wav' | undefined {
    if (mediaType === 'audio/mp3' || mediaType === 'audio/mpeg') return 'mp3';
    if (mediaType === 'audio/wav') return 'wav';
    return undefined;
}

function buildContent(
    msg: AirmailAIMessage,
    blobs: Record<string, { mediaType: string; base64: string }>,
    replicas: ProviderReplicas | undefined
): string | EasyInputMessageContentUnion1[] {
    const text = foldReplayIntoText(msg);
    if (msg.role !== 'user') return text;
    const content: EasyInputMessageContentUnion1[] = [];
    for (const att of resolveAttachments(msg, blobs, replicas)) {
        if (att.kind === 'provider') {
            content.push(
                att.mediaType.startsWith('image/')
                    ? {
                          type: 'input_image',
                          fileId: att.fileId,
                          detail: 'auto',
                      }
                    : { type: 'input_file', fileId: att.fileId }
            );
            continue;
        }
        const dataUrl = `data:${att.mediaType};base64,${att.base64}`;
        if (att.mediaType.startsWith('image/')) {
            content.push({
                type: 'input_image',
                imageUrl: dataUrl,
                detail: 'auto',
            });
        } else if (att.mediaType === 'application/pdf') {
            content.push({
                type: 'input_file',
                filename: att.filename,
                fileData: dataUrl,
            });
        } else if (isTextMimeType(att.mediaType)) {
            content.push({
                type: 'input_text',
                text: decodeBase64Text(att.base64),
            });
        } else if (att.mediaType.startsWith('audio/')) {
            const format = audioFormat(att.mediaType);
            if (!format) {
                throw new Error(
                    `OpenRouter only accepts mp3 and wav audio, got ${att.mediaType}.`
                );
            }
            content.push({
                type: 'input_audio',
                inputAudio: { data: att.base64, format },
            });
        } else if (att.mediaType.startsWith('video/')) {
            content.push({ type: 'input_video', videoUrl: dataUrl });
        } else {
            throw new Error(
                `OpenRouter does not support ${att.mediaType} attachments.`
            );
        }
    }
    if (!content.length) return text;
    if (text) content.unshift({ type: 'input_text', text });
    return content;
}

function collectUrlCitations(
    response: unknown
): Array<{ url: string; title?: string }> {
    const out: Array<{ url: string; title?: string }> = [];
    const seen = new Set<string>();
    const output = (response as { output?: unknown })?.output;
    if (!Array.isArray(output)) return out;
    for (const item of output) {
        const content = (item as { content?: unknown })?.content;
        if (!Array.isArray(content)) continue;
        for (const part of content) {
            const annotations = (part as { annotations?: unknown })
                ?.annotations;
            if (!Array.isArray(annotations)) continue;
            for (const a of annotations) {
                const ann = a as {
                    type?: unknown;
                    url?: unknown;
                    title?: unknown;
                };
                if (
                    ann.type === 'url_citation' &&
                    typeof ann.url === 'string' &&
                    !seen.has(ann.url)
                ) {
                    seen.add(ann.url);
                    out.push({
                        url: ann.url,
                        ...(typeof ann.title === 'string'
                            ? { title: ann.title }
                            : {}),
                    });
                }
            }
        }
    }
    return out;
}

function collectFetchedUrls(response: OpenResponsesResult): string[] {
    const urls = new Set<string>();
    for (const item of response.output) {
        if (item.type === 'openrouter:web_fetch' && item.url && !item.error) {
            urls.add(item.url);
        }
    }
    return [...urls];
}

function* webToolChunks(
    response: OpenResponsesResult
): Generator<AirmailAIChunk> {
    let unidentified = 0;
    for (const item of response.output) {
        if (item.type === 'openrouter:web_search') {
            const toolCallId = item.id ?? `websearch-${unidentified++}`;
            const query = item.action?.query;
            const failed =
                item.status === 'failed' || item.status === 'incomplete';
            const errorText =
                item.error ??
                (failed ? `web search ${item.status}` : undefined);
            yield {
                type: 'tool-call',
                toolCallId,
                name: 'web_search',
                ...(query ? { input: { query } } : {}),
            };
            yield {
                type: 'tool-result',
                toolCallId,
                ...(errorText ? { errorText } : {}),
            };
        } else if (item.type === 'openrouter:web_fetch') {
            const toolCallId = item.id ?? `webfetch-${unidentified++}`;
            const httpFailed =
                item.httpStatus !== undefined && item.httpStatus >= 400;
            const failed =
                !!item.error || httpFailed || item.status === 'incomplete';
            const errorText = failed
                ? [item.httpStatus, item.error].filter(Boolean).join(' ') ||
                  `web fetch ${item.status}`
                : undefined;
            yield {
                type: 'tool-call',
                toolCallId,
                name: 'web_fetch',
                ...(item.url ? { input: { url: item.url } } : {}),
            };
            yield {
                type: 'tool-result',
                toolCallId,
                ...(errorText ? { errorText } : {}),
            };
        }
    }
}

const CONTAINER_FILE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CONTAINER_ATTACHED_FILES = 20;

function sandboxFileIds(
    messages: AirmailAIMessage[],
    replicas: ProviderReplicas | undefined,
    reusingContainer: boolean
): string[] {
    const userMessages = messages.filter((msg) => msg.role === 'user');
    const fileIds = new Set<string>();
    for (const msg of reusingContainer
        ? userMessages.slice(-1)
        : userMessages) {
        for (const att of resolveAttachments(msg, {}, replicas)) {
            if (att.kind === 'provider') fileIds.add(att.fileId);
        }
    }
    return [...fileIds].slice(-MAX_CONTAINER_ATTACHED_FILES);
}

function shellEnvironment(
    containerId: string | undefined,
    fileIds: string[]
): ShellServerToolEnvironment {
    const attached = fileIds.length ? { fileIds } : {};
    return containerId
        ? { type: 'container_reference', containerId, ...attached }
        : { type: 'container_auto', ...attached };
}

function* shellResultChunks(
    item: OutputShellServerToolItem,
    toolCallId: string
): Generator<AirmailAIChunk> {
    const code = item.action?.commands.join('\n');
    if (code) {
        yield {
            type: 'tool-call',
            toolCallId,
            name: 'code_execution',
            input: { code },
        };
    }
    const results = item.output ?? [];
    const stdout = results
        .map((result) => result.stdout)
        .filter(Boolean)
        .join('\n');
    const stderr = results
        .map((result) => result.stderr)
        .filter(Boolean)
        .join('\n');
    const timedOut = results.some(
        (result) => result.outcome.type === 'timeout'
    );
    const failed = item.status === 'failed' || item.status === 'incomplete';
    const errorText =
        item.error ??
        (failed
            ? `code execution ${item.status}`
            : timedOut
              ? 'code execution timed out'
              : undefined);
    yield {
        type: 'tool-result',
        toolCallId,
        ...(stdout || stderr
            ? {
                  output: {
                      ...(stdout ? { stdout } : {}),
                      ...(stderr ? { stderr } : {}),
                  },
              }
            : {}),
        ...(errorText ? { errorText } : {}),
    };
}

interface GeneratedContainerFile {
    containerId: string;
    fileId: string;
    filename: string;
}

async function* generatedFileChunks(
    client: OpenRouter,
    files: Iterable<GeneratedContainerFile>,
    signal: AbortSignal | undefined
): AsyncGenerator<AirmailAIChunk> {
    for (const file of files) {
        const content = await client.containers.downloadContainerFileContent(
            { containerId: file.containerId, fileId: file.fileId },
            signal ? { signal } : undefined
        );
        const bytes = new Uint8Array(await new Response(content).arrayBuffer());
        const filename = file.filename.split('/').pop() || file.fileId;
        yield {
            type: 'file',
            filename,
            mediaType:
                getMimeTypeFromFilename(filename) ?? 'application/octet-stream',
            sizeBytes: bytes.byteLength,
            hash: await hashBytes(bytes.buffer),
            base64: bytesToBase64(bytes),
        };
    }
}

export async function* streamOpenRouter(
    args: ProviderStreamArgs
): AsyncGenerator<AirmailAIChunk> {
    const debugFetch = makeModelFetch('openrouter', args);
    const client = new OpenRouter({
        apiKey: args.apiKey,
        ...(debugFetch
            ? { httpClient: new HTTPClient({ fetcher: debugFetch }) }
            : {}),
        ...(args.params.tagOpenRouterRequests
            ? { appTitle: 'AirmailAI', httpReferer: 'https://airmailai.net' }
            : {}),
    });

    const reasoning = toReasoning(
        args.params.thinkingLevel as string | undefined
    );
    const maxTokens = (args.params.maxTokens as number | undefined) ?? 8192;

    const wireTools = (args.params.tools ?? {}) as Record<
        string,
        string | boolean | undefined
    >;
    const replicas: ProviderReplicas | undefined =
        args.providerFiles && Object.keys(args.providerFiles).length
            ? args.providerFiles
            : undefined;
    const reuseContainerId =
        typeof args.params.container === 'string'
            ? args.params.container
            : undefined;
    const tools: Array<
        | { type: 'openrouter:web_search' }
        | { type: 'openrouter:web_fetch' }
        | ShellServerToolOpenRouter
    > = [];
    if (wireTools.webSearch) tools.push({ type: 'openrouter:web_search' });
    if (wireTools.webFetch) tools.push({ type: 'openrouter:web_fetch' });
    if (wireTools.codeExecution) {
        tools.push({
            type: 'openrouter:shell',
            parameters: {
                engine: 'openrouter',
                environment: shellEnvironment(
                    reuseContainerId,
                    sandboxFileIds(args.messages, replicas, !!reuseContainerId)
                ),
            },
        });
    }

    const input = args.messages.map((msg) => ({
        role: msg.role,
        content: buildContent(msg, args.blobs ?? {}, replicas),
    }));
    const pdfAttached = args.messages.some(
        (msg) =>
            msg.role === 'user' &&
            msg.parts.some(
                (part) =>
                    part.type === 'file' && part.mediaType === 'application/pdf'
            )
    );
    const pdfEngine = args.params.openRouterPdfEngine;
    const plugins: FileParserPlugin[] | undefined =
        pdfAttached &&
        (pdfEngine === 'native' ||
            pdfEngine === 'cloudflare-ai' ||
            pdfEngine === 'mistral-ocr')
            ? [{ id: 'file-parser', pdf: { engine: pdfEngine } }]
            : undefined;

    const requestBody = {
        responsesRequest: {
            model: args.model,
            input,
            ...(args.model.startsWith('anthropic/')
                ? { cacheControl: { type: 'ephemeral' as const } }
                : {}),
            ...(args.system ? { instructions: args.system } : {}),
            maxOutputTokens: maxTokens,
            ...(args.params.temperature !== undefined
                ? { temperature: args.params.temperature as number }
                : {}),
            ...(reasoning ? { reasoning } : {}),
            ...(tools.length ? { tools } : {}),
            ...(plugins ? { plugins } : {}),
            stream: true as const,
        },
    };

    let mode: 'text' | 'reasoning' | null = null;
    let currentId = '';
    let counter = 0;
    let currentTextLen = 0;
    let currentItemBase = 0;
    let lastTextItemId = '';
    const seenSourceIds = new Set<string>();
    let completedResponse: OpenResponsesResult | undefined;
    let stopReason: AirmailAIMessageMetadata['stopReason'];
    const shellCallIds = new Set<string>();
    const generatedFiles = new Map<string, GeneratedContainerFile>();
    let containerId: string | undefined;

    try {
        const stream = await client.responses.send(requestBody, {
            signal: args.signal,
        });
        if (!(stream instanceof EventStream)) {
            throw new Error(
                'OpenRouter returned a non-streaming response to a streaming request'
            );
        }
        for await (const event of stream) {
            if (
                event.type === 'response.output_text.delta' ||
                event.type === 'response.refusal.delta'
            ) {
                if (event.type === 'response.refusal.delta') {
                    stopReason = 'refusal';
                }
                if (mode !== 'text') {
                    if (mode === 'reasoning')
                        yield { type: 'reasoning-end', id: currentId };
                    currentId = `text-${counter++}`;
                    mode = 'text';
                    currentTextLen = 0;
                    lastTextItemId = '';
                    yield { type: 'text-start', id: currentId };
                }
                if (event.itemId !== lastTextItemId) {
                    lastTextItemId = event.itemId;
                    currentItemBase = currentTextLen;
                }
                currentTextLen += event.delta.length;
                yield { type: 'text-delta', id: currentId, delta: event.delta };
            } else if (event.type === 'response.refusal.done') {
                stopReason = 'refusal';
            } else if (event.type === 'response.output_text.annotation.added') {
                const ann = event.annotation as {
                    type?: string;
                    url?: string;
                    title?: string;
                    startIndex?: number;
                    endIndex?: number;
                };
                if (
                    ann.type === 'url_citation' &&
                    typeof ann.url === 'string'
                ) {
                    if (!seenSourceIds.has(ann.url)) {
                        seenSourceIds.add(ann.url);
                        yield {
                            type: 'source-url',
                            sourceId: ann.url,
                            url: ann.url,
                            ...(typeof ann.title === 'string' && ann.title
                                ? { title: ann.title }
                                : {}),
                        };
                    }
                    if (mode === 'text' && event.itemId === lastTextItemId) {
                        yield {
                            type: 'citation',
                            sourceId: ann.url,
                            textId: currentId,
                            ...(typeof ann.startIndex === 'number' &&
                            typeof ann.endIndex === 'number'
                                ? {
                                      textStart:
                                          currentItemBase + ann.startIndex,
                                      textEnd: currentItemBase + ann.endIndex,
                                  }
                                : {}),
                        };
                    }
                }
            } else if (
                event.type === 'response.reasoning_summary_text.delta' ||
                event.type === 'response.reasoning_text.delta'
            ) {
                if (mode !== 'reasoning') {
                    if (mode === 'text')
                        yield { type: 'text-end', id: currentId };
                    currentId = `reasoning-${counter++}`;
                    mode = 'reasoning';
                    yield { type: 'reasoning-start', id: currentId };
                }
                yield {
                    type: 'reasoning-delta',
                    id: currentId,
                    delta: event.delta,
                };
            } else if (
                (event.type === 'response.output_item.added' ||
                    event.type === 'response.output_item.done') &&
                event.item.type === 'openrouter:shell'
            ) {
                const item = event.item;
                const toolCallId = item.id ?? `shell-${event.outputIndex}`;
                if (!shellCallIds.has(toolCallId)) {
                    shellCallIds.add(toolCallId);
                    if (mode === 'text') {
                        yield { type: 'text-end', id: currentId };
                    } else if (mode === 'reasoning') {
                        yield { type: 'reasoning-end', id: currentId };
                    }
                    mode = null;
                    yield {
                        type: 'tool-call',
                        toolCallId,
                        name: 'code_execution',
                    };
                }
                if (event.type === 'response.output_item.done') {
                    yield* shellResultChunks(item, toolCallId);
                    if (item.containerId) containerId = item.containerId;
                    for (const file of item.files ?? []) {
                        generatedFiles.set(file.fileId, file);
                    }
                }
            } else if (event.type === 'response.completed') {
                completedResponse = event.response;
            } else if (event.type === 'response.incomplete') {
                completedResponse = event.response;
                stopReason =
                    event.response.incompleteDetails?.reason ===
                    'content_filter'
                        ? 'content-filter'
                        : 'length';
            } else if (event.type === 'response.failed') {
                throw new Error(
                    event.response.error?.message ??
                        'OpenRouter response failed'
                );
            } else if (event.type === 'error') {
                throw new Error(event.message);
            }
        }

        if (mode === 'text') yield { type: 'text-end', id: currentId };
        else if (mode === 'reasoning')
            yield { type: 'reasoning-end', id: currentId };

        if (completedResponse === undefined) return;

        yield* webToolChunks(completedResponse);

        for (const s of collectUrlCitations(completedResponse)) {
            if (seenSourceIds.has(s.url)) continue;
            seenSourceIds.add(s.url);
            yield {
                type: 'source-url',
                sourceId: s.url,
                url: s.url,
                ...(s.title ? { title: s.title } : {}),
            };
        }
        for (const url of collectFetchedUrls(completedResponse)) {
            if (seenSourceIds.has(url)) continue;
            seenSourceIds.add(url);
            yield { type: 'source-url', sourceId: url, url };
        }

        yield* generatedFileChunks(
            client,
            generatedFiles.values(),
            args.signal
        );

        const usage = completedResponse.usage;
        yield {
            type: 'finish',
            metadata: {
                ...(usage
                    ? {
                          tokens: {
                              input: usage.inputTokens,
                              output: usage.outputTokens,
                          },
                      }
                    : {}),
                ...(stopReason ? { stopReason } : {}),
            },
            ...(containerId
                ? {
                      containerId,
                      containerExpiresAt: new Date(
                          Date.now() + CONTAINER_FILE_RETENTION_MS
                      ).toISOString(),
                  }
                : {}),
        };
    } catch (e) {
        if (args.signal?.aborted) return;
        throw e;
    }
}
