import type { WebSearchSource, WebSearchToolResult } from '@courier/shared';

// Drop duplicates by URL across the whole turn so a single source cited from
// multiple search calls only renders once.
export function dedupeSources(sources: WebSearchSource[]): WebSearchSource[] {
    const unique = new Map<string, WebSearchSource>();
    for (const source of sources) {
        if (!source.url || unique.has(source.url)) continue;
        unique.set(source.url, source);
    }
    return [...unique.values()];
}

// OpenAI/OpenRouter responses share the same `output[].content[].annotations[]`
// shape with `type: 'url_citation'`. Sweep them out and dedupe.
export function collectUrlCitationSources(
    response: unknown
): WebSearchSource[] {
    const out: WebSearchSource[] = [];
    if (!response || typeof response !== 'object') return out;
    const output = (response as { output?: unknown }).output;
    if (!Array.isArray(output)) return out;

    for (const item of output) {
        if (!item || typeof item !== 'object') continue;
        const content = (item as { content?: unknown }).content;
        if (!Array.isArray(content)) continue;

        for (const part of content) {
            if (!part || typeof part !== 'object') continue;
            const annotations = (part as { annotations?: unknown }).annotations;
            if (!Array.isArray(annotations)) continue;

            for (const annotation of annotations) {
                if (!annotation || typeof annotation !== 'object') continue;
                const candidate = annotation as {
                    title?: unknown;
                    type?: unknown;
                    url?: unknown;
                };
                if (
                    candidate.type === 'url_citation' &&
                    typeof candidate.url === 'string'
                ) {
                    out.push({
                        url: candidate.url,
                        ...(typeof candidate.title === 'string'
                            ? { title: candidate.title }
                            : {}),
                    });
                }
            }
        }
    }
    return dedupeSources(out);
}

// Walk the response output in document order and emit one ToolResult per
// `web_search_call`, with the reasoning items that precede it attached as
// `openaiReasoning`. The OpenAI Responses API binds each web_search_call to
// the reasoning item directly before it by id — replaying them out of order
// (or dropping any) errors with "ws_X provided without required rs_Y".
//
// A trailing reasoning item (after the last web_search_call but before the
// final message) is emitted as a callId-less tool result so it still gets
// replayed in position.
//
// Sources from message annotations are placed on the first emitted tool
// result. The UI flattens/dedupes across all entries on render anyway.
export function buildOpenAIResponsesToolResults(
    response: unknown
): WebSearchToolResult[] {
    const out: WebSearchToolResult[] = [];
    const sources = collectUrlCitationSources(response);

    if (!response || typeof response !== 'object') {
        return sources.length ? [{ type: 'web_search', sources }] : [];
    }
    const output = (response as { output?: unknown }).output;
    if (!Array.isArray(output)) {
        return sources.length ? [{ type: 'web_search', sources }] : [];
    }

    let pending: Array<{ id: string; encryptedContent: string }> = [];
    let attachedSources = false;
    const takeSources = () => {
        if (attachedSources) return [] as WebSearchSource[];
        attachedSources = true;
        return sources;
    };

    for (const item of output) {
        if (!item || typeof item !== 'object') continue;
        const candidate = item as {
            type?: unknown;
            id?: unknown;
            encrypted_content?: unknown;
        };

        if (
            candidate.type === 'reasoning' &&
            typeof candidate.id === 'string'
        ) {
            const enc =
                typeof candidate.encrypted_content === 'string'
                    ? candidate.encrypted_content
                    : '';
            // Without encrypted_content there's nothing to replay — drop it.
            // Caller must request `include: ['reasoning.encrypted_content']`.
            if (enc.length > 0) {
                pending.push({ id: candidate.id, encryptedContent: enc });
            }
            continue;
        }

        if (
            candidate.type === 'web_search_call' &&
            typeof candidate.id === 'string'
        ) {
            out.push({
                type: 'web_search',
                callId: candidate.id,
                sources: takeSources(),
                ...(pending.length ? { openaiReasoning: pending } : {}),
            });
            pending = [];
        }
    }

    if (pending.length) {
        out.push({
            type: 'web_search',
            sources: takeSources(),
            openaiReasoning: pending,
        });
    }

    if (out.length === 0 && sources.length > 0) {
        out.push({ type: 'web_search', sources });
    }

    return out;
}
