import {
    type Content,
    GoogleGenAI,
    type GroundingChunk,
    type GroundingSupport,
    Outcome,
    type Part,
    type ThinkingConfig,
    ThinkingLevel,
    type Tool,
    UrlRetrievalStatus,
} from '@google/genai';
import type {
    AirmailAIChunk,
    AirmailAIMessage,
    AirmailAIMessageMetadata,
    ProviderStreamArgs,
} from '@airmailai/shared';
import { log } from '../debug';
import { base64ToBytes, hashBytes } from '../storage/encoding';
import { type ProviderReplicas, resolveAttachments } from './attachments';
import { foldReplayIntoText } from './fold-replay';

function outputFilename(index: number, mediaType: string): string {
    const subtype = mediaType.split('/')[1]?.split(';')[0] ?? '';
    const ext =
        subtype === 'jpeg' ? 'jpg' : subtype === 'plain' ? 'txt' : subtype;
    return `output-${index}.${ext || 'bin'}`;
}

function mapStopReason(
    reason: string | undefined
): AirmailAIMessageMetadata['stopReason'] {
    switch (reason) {
        case undefined:
            return undefined;
        case 'STOP':
            return 'stop';
        case 'MAX_TOKENS':
            return 'length';
        case 'SAFETY':
        case 'RECITATION':
        case 'BLOCKLIST':
        case 'PROHIBITED_CONTENT':
        case 'SPII':
        case 'IMAGE_SAFETY':
        case 'IMAGE_PROHIBITED_CONTENT':
        case 'IMAGE_RECITATION':
            return 'content-filter';
        default:
            throw new Error(`Google response stopped: ${reason}`);
    }
}

function buildThinkingConfig(
    model: string,
    thinkingLevel: string | undefined,
    adaptive: boolean
): ThinkingConfig | undefined {
    if (!thinkingLevel) return undefined;

    if (model.includes('2.5')) {
        if (thinkingLevel === 'none') return { thinkingBudget: 0 };
        if (adaptive) return { thinkingBudget: -1, includeThoughts: true };
        const budgets: Record<string, number> = {
            low: 512,
            medium: 4096,
            high: 8192,
            max: 16384,
            xhigh: 24576,
        };
        const budget = budgets[thinkingLevel];
        if (budget == null) return undefined;
        return { thinkingBudget: Math.max(128, budget), includeThoughts: true };
    }

    if (thinkingLevel === 'none') return undefined;
    const levelMap: Record<string, ThinkingLevel> = {
        minimal: ThinkingLevel.MINIMAL,
        low: ThinkingLevel.LOW,
        medium: ThinkingLevel.MEDIUM,
        high: ThinkingLevel.HIGH,
        max: ThinkingLevel.HIGH,
        xhigh: ThinkingLevel.HIGH,
    };
    const level = levelMap[thinkingLevel];
    if (!level) return undefined;
    return { thinkingLevel: level, includeThoughts: true };
}

function toGoogleContents(
    messages: AirmailAIMessage[],
    blobs: Record<string, { mediaType: string; base64: string }>,
    replicas: ProviderReplicas | undefined
): Content[] {
    return messages.map((msg) => {
        const text = foldReplayIntoText(msg);
        const parts: Part[] = [];
        if (text) parts.push({ text });
        for (const att of resolveAttachments(msg, blobs, replicas)) {
            if (att.kind === 'provider') {
                if (att.providerId !== 'google') continue;
                if (att.uri) {
                    parts.push({
                        fileData: {
                            fileUri: att.uri,
                            ...(att.mediaType
                                ? { mimeType: att.mediaType }
                                : {}),
                        },
                    });
                } else if (att.base64) {
                    parts.push({
                        inlineData: {
                            mimeType: att.mediaType,
                            data: att.base64,
                        },
                    });
                }
                continue;
            }
            parts.push({
                inlineData: { mimeType: att.mediaType, data: att.base64 },
            });
        }
        if (parts.length === 0) parts.push({ text: '' });
        return {
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts,
        };
    });
}

export async function* streamGoogle(
    args: ProviderStreamArgs
): AsyncGenerator<AirmailAIChunk> {
    const client = new GoogleGenAI({ apiKey: args.apiKey });

    const thinkingLevel = args.params.thinkingLevel as string | undefined;
    const adaptive =
        (args.params.adaptiveThinking as boolean | undefined) ?? true;
    const thinkingConfig = buildThinkingConfig(
        args.model,
        thinkingLevel,
        adaptive
    );
    const maxTokens = (args.params.maxTokens as number | undefined) ?? 8192;

    const wireTools = (args.params.tools ?? {}) as Record<
        string,
        string | boolean | undefined
    >;
    const tools: Tool[] = [];
    if (wireTools.webSearch) tools.push({ googleSearch: {} });
    if (wireTools.webFetch) tools.push({ urlContext: {} });
    if (wireTools.codeExecution) tools.push({ codeExecution: {} });

    const replicas: ProviderReplicas | undefined =
        args.providerFiles && Object.keys(args.providerFiles).length
            ? { providerId: 'google', files: args.providerFiles }
            : undefined;
    const requestBody = {
        model: args.model,
        contents: toGoogleContents(args.messages, args.blobs ?? {}, replicas),
        config: {
            ...(args.system ? { systemInstruction: args.system } : {}),
            maxOutputTokens: maxTokens,
            ...(args.params.temperature !== undefined
                ? { temperature: args.params.temperature as number }
                : {}),
            ...(thinkingConfig ? { thinkingConfig } : {}),
            ...(tools.length ? { tools } : {}),
            ...(args.signal ? { abortSignal: args.signal } : {}),
        },
    };

    // *** @google/genai's GoogleGenAIOptions has no fetch override (only
    // httpOptions: baseUrl/headers/timeout/extraBody), so unlike the other
    // providers we can't use makeDebugFetch; we log the SDK input here instead.
    log.debug('google: -> sdk input', requestBody);

    let mode: 'text' | 'reasoning' | null = null;
    let currentId = '';
    let counter = 0;
    let fileCounter = 0;
    let pendingCodeExecId: string | undefined;
    const seenUrls = new Set<string>();
    const seenSearchQueries = new Set<string>();
    const seenFetchedUrls = new Set<string>();
    const textAccum = new Map<string, string>();
    let latestGroundingChunks: GroundingChunk[] = [];
    let latestGroundingSupports: GroundingSupport[] = [];
    let searchSuggestionsHtml = '';
    let promptTokens = 0;
    let candidateTokens = 0;
    let stopReason: AirmailAIMessageMetadata['stopReason'];

    try {
        const stream = await client.models.generateContentStream(requestBody);
        for await (const chunk of stream) {
            const promptFeedback = chunk.promptFeedback;
            if (promptFeedback?.blockReason) {
                throw new Error(
                    promptFeedback.blockReasonMessage
                        ? `Google blocked the prompt: ${promptFeedback.blockReasonMessage}`
                        : `Google blocked the prompt (${promptFeedback.blockReason})`
                );
            }
            const candidate = chunk.candidates?.[0];

            for (const query of candidate?.groundingMetadata
                ?.webSearchQueries ?? []) {
                if (seenSearchQueries.has(query)) continue;
                seenSearchQueries.add(query);
                const id = `websearch-${seenSearchQueries.size}`;
                yield {
                    type: 'tool-call',
                    toolCallId: id,
                    name: 'web_search',
                    input: { query },
                };
                yield { type: 'tool-result', toolCallId: id };
            }

            for (const um of candidate?.urlContextMetadata?.urlMetadata ?? []) {
                const url = um.retrievedUrl;
                if (!url || seenFetchedUrls.has(url)) continue;
                seenFetchedUrls.add(url);
                const id = `webfetch-${seenFetchedUrls.size}`;
                const ok =
                    um.urlRetrievalStatus == null ||
                    um.urlRetrievalStatus ===
                        UrlRetrievalStatus.URL_RETRIEVAL_STATUS_SUCCESS;
                yield {
                    type: 'tool-call',
                    toolCallId: id,
                    name: 'web_fetch',
                    input: { url },
                };
                yield {
                    type: 'tool-result',
                    toolCallId: id,
                    ...(ok ? {} : { errorText: String(um.urlRetrievalStatus) }),
                };
                if (ok && !seenUrls.has(url)) {
                    seenUrls.add(url);
                    yield { type: 'source-url', sourceId: url, url };
                }
            }

            const gm = candidate?.groundingMetadata;
            if (gm?.groundingChunks?.length) {
                latestGroundingChunks = gm.groundingChunks;
            }
            if (gm?.groundingSupports?.length) {
                latestGroundingSupports = gm.groundingSupports;
            }
            if (gm?.searchEntryPoint?.renderedContent) {
                searchSuggestionsHtml = gm.searchEntryPoint.renderedContent;
            }
            for (const gc of gm?.groundingChunks ?? []) {
                const url = gc.web?.uri;
                if (typeof url === 'string' && !seenUrls.has(url)) {
                    seenUrls.add(url);
                    yield {
                        type: 'source-url',
                        sourceId: url,
                        url,
                        ...(gc.web?.title ? { title: gc.web.title } : {}),
                    };
                }
            }

            for (const part of candidate?.content?.parts ?? []) {
                if (part.executableCode?.code != null) {
                    const id =
                        part.executableCode.id ?? `codeexec-${counter++}`;
                    pendingCodeExecId = id;
                    yield {
                        type: 'tool-call',
                        toolCallId: id,
                        name: 'code_execution',
                        input: { code: part.executableCode.code },
                    };
                    continue;
                }
                if (part.codeExecutionResult) {
                    const result = part.codeExecutionResult;
                    const id =
                        result.id ??
                        pendingCodeExecId ??
                        `codeexec-${counter++}`;
                    pendingCodeExecId = undefined;
                    const ok =
                        result.outcome == null ||
                        result.outcome === Outcome.OUTCOME_OK;
                    const output =
                        typeof result.output === 'string'
                            ? result.output
                            : undefined;
                    yield {
                        type: 'tool-result',
                        toolCallId: id,
                        ...(output
                            ? {
                                  output: ok
                                      ? { stdout: output }
                                      : { stderr: output },
                              }
                            : {}),
                        ...(ok ? {} : { errorText: String(result.outcome) }),
                    };
                    continue;
                }
                if (part.inlineData?.data) {
                    const data = part.inlineData.data;
                    const bytes = base64ToBytes(data);
                    const hash = await hashBytes(bytes.buffer);
                    const mediaType =
                        part.inlineData.mimeType ?? 'application/octet-stream';
                    fileCounter++;
                    yield {
                        type: 'file',
                        filename: outputFilename(fileCounter, mediaType),
                        mediaType,
                        sizeBytes: bytes.byteLength,
                        hash,
                        base64: data,
                    };
                    continue;
                }
                if (part.text == null) continue;
                const partMode = part.thought ? 'reasoning' : 'text';
                if (partMode !== mode) {
                    if (mode === 'text')
                        yield { type: 'text-end', id: currentId };
                    else if (mode === 'reasoning')
                        yield { type: 'reasoning-end', id: currentId };
                    currentId = `${partMode}-${counter++}`;
                    mode = partMode;
                    yield partMode === 'text'
                        ? { type: 'text-start', id: currentId }
                        : { type: 'reasoning-start', id: currentId };
                }
                if (partMode === 'text') {
                    textAccum.set(
                        currentId,
                        (textAccum.get(currentId) ?? '') + part.text
                    );
                }
                yield partMode === 'text'
                    ? { type: 'text-delta', id: currentId, delta: part.text }
                    : {
                          type: 'reasoning-delta',
                          id: currentId,
                          delta: part.text,
                      };
            }

            const usage = chunk.usageMetadata;
            if (usage?.promptTokenCount != null)
                promptTokens = usage.promptTokenCount;
            if (usage?.candidatesTokenCount != null)
                candidateTokens = usage.candidatesTokenCount;
            if (candidate?.finishReason)
                stopReason = mapStopReason(candidate.finishReason);
        }

        if (mode === 'text') yield { type: 'text-end', id: currentId };
        else if (mode === 'reasoning')
            yield { type: 'reasoning-end', id: currentId };

        const cursors = new Map<string, number>();
        for (const support of latestGroundingSupports) {
            const segText = support.segment?.text;
            const chunkIndices = support.groundingChunkIndices;
            if (!segText || !chunkIndices?.length) continue;
            let match: { textId: string; start: number } | undefined;
            for (const [textId, accum] of textAccum) {
                const from = cursors.get(textId) ?? 0;
                let at = accum.indexOf(segText, from);
                if (at === -1) at = accum.indexOf(segText);
                if (at === -1) continue;
                cursors.set(textId, at + segText.length);
                match = { textId, start: at };
                break;
            }
            if (!match) continue;
            for (const idx of chunkIndices) {
                const web = latestGroundingChunks[idx]?.web;
                const url = web?.uri;
                if (!web || typeof url !== 'string') continue;
                if (!seenUrls.has(url)) {
                    seenUrls.add(url);
                    yield {
                        type: 'source-url',
                        sourceId: url,
                        url,
                        ...(web.title ? { title: web.title } : {}),
                    };
                }
                yield {
                    type: 'citation',
                    sourceId: url,
                    textId: match.textId,
                    textStart: match.start,
                    textEnd: match.start + segText.length,
                };
            }
        }
        if (searchSuggestionsHtml) {
            yield {
                type: 'google-search-suggestions',
                html: searchSuggestionsHtml,
            };
        }

        yield {
            type: 'finish',
            metadata: {
                tokens: { input: promptTokens, output: candidateTokens },
                ...(stopReason ? { stopReason } : {}),
            },
        };
    } catch (e) {
        if (args.signal?.aborted) return;
        throw e;
    }
}
