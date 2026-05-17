import type {
    HydratedChatMessage,
    StreamHandlers,
    WebSearchSource,
    WebSearchToolResult,
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
import { dedupeSources } from './tool-results';

const LOG = '[courier:ext]';

// We are currently still using the generateContent API because the new
// Interactions API is still in beta and is subject to breaking changes.

// Google's web search tool is an object KEY (not a discriminator value) in
// the request body — hoist anyway so anyone scanning provider files finds
// the tool wiring in a consistent spot.
const WEB_SEARCH_TOOL_KEY = 'googleSearch' as const;

// WORKAROUND — do not copy this pattern unless the upstream provider gives
// you no other option. Gemini's googleSearch tool returns its URL set in
// `Candidate.groundingMetadata`, which is documented as Output-only — the
// API does not accept it as input on the next turn, and `Content` has no
// slot to put it in regardless. The `thoughtSignature` on the toolCall /
// toolResponse / text parts is a thought-continuity token, not an encrypted
// state blob (confirmed against the @google/genai SDK source), so replaying
// signed parts tells the model "you searched" but doesn't restore the URL
// list. Google's own `Chats` history helper drops grounding metadata for
// the same reason. To give the model retrievable access to the URLs on a
// follow-up turn, the only carrier is plain text in the assistant turn —
// so on replay we append a `Sources:` markdown list to the stored assistant
// content. Verified end-to-end via scripts/tool-call-test.ts: the model
// recites all URLs verbatim and doesn't re-search.
function withSourcesBlock(
    text: string,
    toolResults: WebSearchToolResult[]
): string {
    const lines: string[] = [];
    let n = 1;
    for (const tr of toolResults) {
        for (const s of tr.sources) {
            lines.push(
                s.title ? `${n}. [${s.title}](${s.url})` : `${n}. ${s.url}`
            );
            n++;
        }
    }
    if (!lines.length) return text;
    const block = 'Sources:\n' + lines.join('\n');
    return text ? `${text}\n\n${block}` : block;
}

function toGoogleContents(messages: HydratedChatMessage[]): Content[] {
    return messages
        .filter((m) => m.role !== 'system')
        .map((msg): Content => {
            const role = msg.role === 'assistant' ? 'model' : 'user';
            const parts: Part[] = [];

            const content =
                msg.role === 'assistant' && msg.toolResults?.length
                    ? withSourcesBlock(msg.content, msg.toolResults)
                    : msg.content;

            for (const att of msg.attachments ?? []) {
                parts.push({
                    inlineData: { mimeType: att.mediaType, data: att.data },
                });
            }
            if (content) {
                parts.push({ text: content });
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

function collectGoogleSources(chunk: unknown): WebSearchSource[] {
    if (!chunk || typeof chunk !== 'object') return [];
    const candidates = (chunk as { candidates?: unknown }).candidates;
    if (!Array.isArray(candidates)) return [];

    const sources: WebSearchSource[] = [];
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
                    ...(typeof source.title === 'string'
                        ? { title: source.title }
                        : {}),
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
        ? [{ [WEB_SEARCH_TOOL_KEY]: {} }]
        : undefined;

    console.log(LOG, 'google: stream start', {
        model,
        contents: contents.length,
        hasSystem: !!systemMsg,
        params,
    });

    const requestBody = {
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
    };

    if (DEBUG_API_LOGGING) {
        console.log(LOG, '[debug] google: → request', requestBody);
    }

    try {
        const stream = await client.models.generateContentStream(requestBody);

        let firstChunk = true;
        let lastUsage: StreamUsage | undefined;
        const sources: WebSearchSource[] = [];
        const debugChunks: unknown[] = [];

        for await (const chunk of stream) {
            if (DEBUG_API_LOGGING) debugChunks.push(chunk);
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

        const deduped = dedupeSources(sources);
        if (deduped.length) {
            const toolResult: WebSearchToolResult = {
                type: 'web_search',
                sources: deduped,
            };
            handlers.onToolResults?.([toolResult]);
        }
        console.log(LOG, 'google: stream done');
        if (DEBUG_API_LOGGING) {
            console.log(LOG, '[debug] google: ← response', {
                chunks: debugChunks,
                usage: lastUsage,
            });
        }
        handlers.onDone(lastUsage);
    } catch (e) {
        if (signal?.aborted) return;
        const msg = e instanceof Error ? e.message : String(e);
        console.error(LOG, 'google: error', msg);
        handlers.onError(msg);
    }
}
