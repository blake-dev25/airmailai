import {
    type Content,
    GoogleGenAI,
    Outcome,
    type ThinkingConfig,
    ThinkingLevel,
    type Tool,
} from '@google/genai';
import type {
    CourierAIChunk,
    CourierAIMessage,
    CourierAIMessageMetadata,
    ProviderStreamArgs,
} from '@courierai/shared';
import { DEBUG_API_LOGGING } from '../debug';
import { foldSourcesIntoText } from './fold-sources';

const LOG = '[courierai:ext]';

function mapStopReason(
    reason: string | undefined
): CourierAIMessageMetadata['stopReason'] {
    if (!reason) return undefined;
    if (reason === 'MAX_TOKENS') return 'length';
    if (
        reason === 'SAFETY' ||
        reason === 'RECITATION' ||
        reason === 'BLOCKLIST'
    )
        return 'content-filter';
    return 'stop';
}

// Gemini 2.5 uses thinkingBudget (token count); 3.x uses thinkingLevel enum.
// adaptive (thinkingBudget: -1) lets the model decide and works on both.
function buildThinkingConfig(
    model: string,
    thinkingLevel: string | undefined,
    adaptive: boolean
): ThinkingConfig | undefined {
    if (!thinkingLevel || thinkingLevel === 'none') return undefined;
    if (adaptive) return { thinkingBudget: -1, includeThoughts: true };

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
        return { thinkingBudget: Math.max(128, budget), includeThoughts: true };
    }

    // Gemini 3+. max/xhigh have no distinct level, so clamp to HIGH.
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

function toGoogleContents(messages: CourierAIMessage[]): Content[] {
    // Google grounding URLs are output-only and don't round-trip, so assistant
    // turns replay via the Sources text-fold (foldSourcesIntoText). TODO:
    // hydrate data-attachment parts into inlineData parts.
    return messages.map((msg) => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: foldSourcesIntoText(msg) }],
    }));
}

// Hand-rolled Google provider. Gemini streams whole response chunks with no
// per-part boundaries, so we synthesize text/reasoning start/end whenever the
// part mode flips. Grounding metadata -> source-url; executableCode /
// codeExecutionResult parts -> code_execution tool-call/result. See plan D4.
export async function* streamGoogle(
    args: ProviderStreamArgs
): AsyncGenerator<CourierAIChunk> {
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

    const requestBody = {
        model: args.model,
        contents: toGoogleContents(args.messages),
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

    // @google/genai transforms this object into the wire body internally and
    // does not expose a fetch hook here; logging the final SDK output would mean
    // patching the SDK/global fetch, so this logs the SDK input request instead.
    if (DEBUG_API_LOGGING) {
        console.log(LOG, '[debug] google: -> sdk input', requestBody);
    }

    // Gemini has no part ids; synthesize them and bracket on mode switches.
    let mode: 'text' | 'reasoning' | null = null;
    let currentId = '';
    let counter = 0;
    // Gemini pairs an executableCode part with its codeExecutionResult via a
    // shared `id`; hold the last code id to pair them when that id is absent.
    let pendingCodeExecId: string | undefined;
    const seenUrls = new Set<string>();
    let promptTokens = 0;
    let candidateTokens = 0;
    let stopReason: CourierAIMessageMetadata['stopReason'];

    try {
        const stream = await client.models.generateContentStream(requestBody);
        for await (const chunk of stream) {
            const candidate = chunk.candidates?.[0];

            for (const gc of candidate?.groundingMetadata?.groundingChunks ??
                []) {
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
                    // OUTCOME_OK -> output is stdout; otherwise it's stderr/desc.
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
