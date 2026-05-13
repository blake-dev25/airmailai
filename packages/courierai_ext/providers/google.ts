import type {
    HydratedChatMessage,
    StreamHandlers,
    StreamUsage,
} from '@courier/shared';
import {
    type Content,
    GoogleGenAI,
    type Part,
    type ThinkingConfig,
    type Tool,
    ThinkingLevel,
} from '@google/genai';
import { DEBUG_API_LOGGING } from '../debug';
import { formatSources, type SourceLink } from './sources';

const LOG = '[courier:ext]';

function toGoogleContents(messages: HydratedChatMessage[]): Content[] {
    return messages
        .filter((m) => m.role !== 'system')
        .map((msg): Content => {
            const role = msg.role === 'assistant' ? 'model' : 'user';
            const parts: Part[] = [];

            for (const att of msg.attachments ?? []) {
                parts.push({
                    inlineData: { mimeType: att.mediaType, data: att.data },
                });
            }
            if (msg.content) {
                parts.push({ text: msg.content });
            }

            return { role, parts };
        });
}

// Gemini 2.5 uses thinkingBudget (token count); 3.x uses thinkingLevel enum.
function buildThinkingConfig(
    model: string,
    thinkingLevel: string | undefined,
    wantsThoughts: boolean
): ThinkingConfig | undefined {
    if (!thinkingLevel || thinkingLevel === 'none') return undefined;

    if (model.includes('2.5')) {
        const budgets: Record<string, number> = {
            low: 512,
            medium: 4096,
            high: 8192,
            max: 16384,
            xhigh: 24576,
        };
        const budget = budgets[thinkingLevel];
        if (budget == null) return undefined;
        return { thinkingBudget: Math.max(128, budget) };
    }

    // Gemini 3+
    const levelMap: Record<string, ThinkingLevel> = {
        low: ThinkingLevel.LOW,
        medium: ThinkingLevel.MEDIUM,
        high: ThinkingLevel.HIGH,
        max: ThinkingLevel.HIGH,
        xhigh: ThinkingLevel.HIGH,
    };
    const level = levelMap[thinkingLevel];
    if (!level) return undefined;
    return {
        thinkingLevel: level,
        includeThoughts: wantsThoughts,
    };
}

function collectGoogleSources(chunk: unknown): SourceLink[] {
    if (!chunk || typeof chunk !== 'object') return [];
    const candidates = (chunk as { candidates?: unknown }).candidates;
    if (!Array.isArray(candidates)) return [];

    const sources: SourceLink[] = [];
    for (const candidate of candidates) {
        if (!candidate || typeof candidate !== 'object') continue;
        const metadata = (candidate as { groundingMetadata?: unknown })
            .groundingMetadata;
        if (!metadata || typeof metadata !== 'object') continue;
        const groundingChunks = (metadata as { groundingChunks?: unknown })
            .groundingChunks;
        if (!Array.isArray(groundingChunks)) continue;

        for (const groundingChunk of groundingChunks) {
            if (!groundingChunk || typeof groundingChunk !== 'object') continue;
            const web = (groundingChunk as { web?: unknown }).web;
            if (!web || typeof web !== 'object') continue;
            const source = web as { title?: unknown; uri?: unknown };
            if (typeof source.uri === 'string') {
                sources.push({
                    url: source.uri,
                    title:
                        typeof source.title === 'string'
                            ? source.title
                            : undefined,
                });
            }
        }
    }

    return sources;
}

export async function streamGoogle(
    apiKey: string,
    model: string,
    messages: HydratedChatMessage[],
    params: Record<string, unknown>,
    handlers: StreamHandlers,
    signal?: AbortSignal
): Promise<void> {
    const client = new GoogleGenAI({ apiKey });

    const systemMsg = messages.find((m) => m.role === 'system');
    const contents = toGoogleContents(messages);

    const thinkingLevel = params.thinkingLevel as string | undefined;
    const wantsThoughts =
        !!handlers.onThinking && !!thinkingLevel && thinkingLevel !== 'none';
    const thinkingCfg = buildThinkingConfig(
        model,
        thinkingLevel,
        wantsThoughts
    );
    const webSearchTools: Tool[] | undefined = params.webSearch
        ? [{ googleSearch: {} }]
        : undefined;

    console.log(LOG, 'google: stream start', {
        model,
        contents: contents.length,
        hasSystem: !!systemMsg,
        params,
    });

    try {
        const stream = await client.models.generateContentStream({
            model,
            contents,
            config: {
                ...(systemMsg ? { systemInstruction: systemMsg.content } : {}),
                maxOutputTokens: (params.maxTokens as number) ?? 8192,
                ...(params.temperature !== undefined
                    ? { temperature: params.temperature as number }
                    : {}),
                ...(thinkingCfg ? { thinkingConfig: thinkingCfg } : {}),
                ...(webSearchTools ? { tools: webSearchTools } : {}),
                ...(signal ? { abortSignal: signal } : {}),
            },
        });

        let firstChunk = true;
        let lastUsage: StreamUsage | undefined;
        const sources: SourceLink[] = [];

        for await (const chunk of stream) {
            sources.push(...collectGoogleSources(chunk));
            for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
                if (part.thought && part.text) {
                    handlers.onThinking?.(part.text);
                } else if (part.text) {
                    if (firstChunk) {
                        console.log(LOG, 'google: first chunk received');
                        firstChunk = false;
                    }
                    handlers.onChunk(part.text);
                }
            }

            const meta = chunk.usageMetadata;
            if (meta?.promptTokenCount != null) {
                lastUsage = {
                    inputTokens: meta.promptTokenCount,
                    outputTokens: meta.candidatesTokenCount ?? 0,
                };
            }
        }

        const sourceChunk = formatSources(sources);
        if (sourceChunk) handlers.onChunk(sourceChunk);
        console.log(LOG, 'google: stream done');
        if (DEBUG_API_LOGGING) {
            console.log(LOG, '[debug] usage', lastUsage);
        }
        handlers.onDone(lastUsage);
    } catch (e) {
        if (signal?.aborted) return;
        const msg = e instanceof Error ? e.message : String(e);
        console.error(LOG, 'google: error', msg);
        handlers.onError(msg);
    }
}
