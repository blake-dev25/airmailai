import { HTTPClient, OpenRouter } from '@openrouter/sdk';
import type { CourierAIChunk, ProviderStreamArgs } from '@courierai/shared';
import { makeDebugFetch } from './debug-fetch';
import { foldSourcesIntoText } from './fold-sources';

type Effort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

// Our thinkingLevel vocabulary -> OpenRouter's reasoning.effort enum. 'max'
// clamps to 'xhigh'; 'none'/unset returns undefined to skip the field.
function toEffort(level: string | undefined): Effort | undefined {
    if (!level || level === 'none') return undefined;
    if (level === 'max') return 'xhigh';
    if (
        level === 'minimal' ||
        level === 'low' ||
        level === 'medium' ||
        level === 'high' ||
        level === 'xhigh'
    ) {
        return level;
    }
    return undefined;
}

// OpenRouter strips upstream encrypted search state, so web search replays via
// the Sources text-fold (foldSourcesIntoText), and sources arrive in the final
// `completed` response (not as streaming annotations). Sweep them out there.
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

// web_fetch results don't arrive as url_citation annotations - the fetched page
// surfaces as an `openrouter:web_fetch` output item carrying its url (and the
// page text we don't keep). Sweep those urls so the fetched page shows in the
// Sources block, same as citations (display-only: OpenRouter can't round-trip
// native tool results, so replay is the Sources text-fold).
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

// Hand-rolled OpenRouter provider (Responses API passthrough). Mirrors OpenAI's
// event shapes; synthesizes text/reasoning brackets on mode switches (no
// content-part boundary events guaranteed) and sweeps citations at completion.
export async function* streamOpenRouter(
    args: ProviderStreamArgs
): AsyncGenerator<CourierAIChunk> {
    const debugFetch = makeDebugFetch('openrouter');
    const client = new OpenRouter({
        apiKey: args.apiKey,
        ...(debugFetch
            ? { httpClient: new HTTPClient({ fetcher: debugFetch }) }
            : {}),
        ...(args.params.tagOpenRouterRequests
            ? { appTitle: 'CourierAI', httpReferer: 'https://courierai.net' }
            : {}),
    });

    const effort = toEffort(args.params.thinkingLevel as string | undefined);
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

    const requestBody = {
        responsesRequest: {
            model: args.model,
            input: args.messages.map((msg) => ({
                role: msg.role,
                content: foldSourcesIntoText(msg),
            })),
            ...(args.system ? { instructions: args.system } : {}),
            maxOutputTokens: maxTokens,
            ...(args.params.temperature !== undefined
                ? { temperature: args.params.temperature as number }
                : {}),
            ...(effort
                ? { reasoning: { effort, summary: 'auto' as const } }
                : {}),
            ...(tools.length ? { tools } : {}),
            stream: true as const,
        },
    };

    let mode: 'text' | 'reasoning' | null = null;
    let currentId = '';
    let counter = 0;
    let completedResponse: unknown;

    try {
        const stream = await client.beta.responses.send(requestBody, {
            signal: args.signal,
        });
        for await (const event of stream) {
            if (event.type === 'response.output_text.delta') {
                if (mode !== 'text') {
                    if (mode === 'reasoning')
                        yield { type: 'reasoning-end', id: currentId };
                    currentId = `text-${counter++}`;
                    mode = 'text';
                    yield { type: 'text-start', id: currentId };
                }
                yield { type: 'text-delta', id: currentId, delta: event.delta };
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
            }
        }

        if (mode === 'text') yield { type: 'text-end', id: currentId };
        else if (mode === 'reasoning')
            yield { type: 'reasoning-end', id: currentId };

        const citedUrls = new Set<string>();
        for (const s of collectUrlCitations(completedResponse)) {
            citedUrls.add(s.url);
            yield {
                type: 'source-url',
                sourceId: s.url,
                url: s.url,
                ...(s.title ? { title: s.title } : {}),
            };
        }
        for (const url of collectFetchedUrls(completedResponse)) {
            if (citedUrls.has(url)) continue;
            yield { type: 'source-url', sourceId: url, url };
        }

        const usage = (completedResponse as { usage?: Record<string, unknown> })
            ?.usage;
        // OpenRouter's Responses passthrough has flip-flopped between camelCase
        // and snake_case across versions; accept either.
        const input = Number(usage?.inputTokens ?? usage?.input_tokens);
        const output = Number(usage?.outputTokens ?? usage?.output_tokens);
        yield {
            type: 'finish',
            metadata:
                Number.isFinite(input) && Number.isFinite(output)
                    ? { tokens: { input, output } }
                    : {},
        };
    } catch (e) {
        if (args.signal?.aborted) return;
        throw e;
    }
}
