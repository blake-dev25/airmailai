import { HTTPClient, OpenRouter } from '@openrouter/sdk';
import { EventStream } from '@openrouter/sdk/lib/event-streams.js';
import type {
    EasyInputMessageContentUnion1,
    FileParserPlugin,
} from '@openrouter/sdk/models';
import type {
    AirmailAIChunk,
    AirmailAIMessage,
    AirmailAIMessageMetadata,
    ProviderStreamArgs,
} from '@airmailai/shared';
import { resolveAttachments } from './attachments';
import { makeDebugFetch } from './debug-fetch';
import { foldReplayIntoText } from './fold-replay';
import { decodeBase64Text } from '../storage/encoding';

type Effort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

type ReasoningConfig = { effort: Effort; summary: 'auto' } | { enabled: false };

function toReasoning(level: string | undefined): ReasoningConfig | undefined {
    if (!level) return undefined;
    if (level === 'none') return { enabled: false };
    if (level === 'max') return { effort: 'xhigh', summary: 'auto' };
    if (
        level === 'minimal' ||
        level === 'low' ||
        level === 'medium' ||
        level === 'high' ||
        level === 'xhigh'
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
    blobs: Record<string, { mediaType: string; base64: string }>
): string | EasyInputMessageContentUnion1[] {
    const text = foldReplayIntoText(msg);
    if (msg.role !== 'user') return text;
    const content: EasyInputMessageContentUnion1[] = [];
    for (const att of resolveAttachments(msg, blobs)) {
        if (att.kind === 'provider') continue;
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
        } else if (att.mediaType.startsWith('text/')) {
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

function collectFetchedUrls(response: unknown): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const output = (response as { output?: unknown })?.output;
    if (!Array.isArray(output)) return out;
    for (const item of output) {
        const it = item as { type?: unknown; url?: unknown };
        if (
            it.type === 'openrouter:web_fetch' &&
            typeof it.url === 'string' &&
            !seen.has(it.url)
        ) {
            seen.add(it.url);
            out.push(it.url);
        }
    }
    return out;
}

export async function* streamOpenRouter(
    args: ProviderStreamArgs
): AsyncGenerator<AirmailAIChunk> {
    const debugFetch = makeDebugFetch('openrouter');
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
    const tools: Array<
        { type: 'openrouter:web_search' } | { type: 'openrouter:web_fetch' }
    > = [];
    if (wireTools.webSearch) tools.push({ type: 'openrouter:web_search' });
    if (wireTools.webFetch) tools.push({ type: 'openrouter:web_fetch' });

    const input = args.messages.map((msg) => ({
        role: msg.role,
        content: buildContent(msg, args.blobs ?? {}),
    }));
    const pdfAttached = input.some(
        (m) =>
            Array.isArray(m.content) &&
            m.content.some((p) => p.type === 'input_file')
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
    let completedResponse: unknown;
    let stopReason: AirmailAIMessageMetadata['stopReason'];

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
            } else if (event.type === 'response.reasoning_summary_text.delta') {
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

        const usage = (completedResponse as { usage?: Record<string, unknown> })
            ?.usage;
        const input = Number(usage?.inputTokens ?? usage?.input_tokens);
        const output = Number(usage?.outputTokens ?? usage?.output_tokens);
        yield {
            type: 'finish',
            metadata: {
                ...(Number.isFinite(input) && Number.isFinite(output)
                    ? { tokens: { input, output } }
                    : {}),
                ...(stopReason ? { stopReason } : {}),
            },
        };
    } catch (e) {
        if (args.signal?.aborted) return;
        throw e;
    }
}
