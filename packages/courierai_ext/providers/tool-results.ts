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

// OpenAI/OpenRouter both expose `web_search_call` items with an `id` we want
// to preserve for re-injection. Returns the list of call IDs in order.
export function collectWebSearchCallIds(response: unknown): string[] {
    const ids: string[] = [];
    if (!response || typeof response !== 'object') return ids;
    const output = (response as { output?: unknown }).output;
    if (!Array.isArray(output)) return ids;

    for (const item of output) {
        if (!item || typeof item !== 'object') continue;
        const candidate = item as { id?: unknown; type?: unknown };
        if (
            candidate.type === 'web_search_call' &&
            typeof candidate.id === 'string'
        ) {
            ids.push(candidate.id);
        }
    }
    return ids;
}

// Build a single ToolResult bundling all citation sources under the first
// observed call id (typical case: one search call per turn). When there are
// multiple call ids and we re-inject, providers that need per-call binding
// can split this back out, but for collection we keep it one entry.
export function buildResponsesToolResults(
    callIds: string[],
    sources: WebSearchSource[]
): WebSearchToolResult[] {
    if (callIds.length === 0 && sources.length === 0) return [];
    return [
        {
            type: 'web_search',
            ...(callIds[0] ? { callId: callIds[0] } : {}),
            sources,
        },
    ];
}
