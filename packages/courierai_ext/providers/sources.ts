export interface SourceLink {
    title?: string | null;
    url: string;
}

function escapeMarkdown(text: string): string {
    return text
        .replace(/\\/g, '\\\\')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]');
}

function escapeMarkdownUrl(url: string): string {
    return url.replace(/\s/g, '%20').replace(/\)/g, '%29');
}

export function formatSources(sources: SourceLink[]): string {
    const unique = new Map<string, SourceLink>();
    for (const source of sources) {
        if (!source.url || unique.has(source.url)) continue;
        unique.set(source.url, source);
    }

    if (unique.size === 0) return '';

    const rows = [...unique.values()].map((source, index) => {
        const title = source.title?.trim() || source.url;
        return `${index + 1}. [${escapeMarkdown(title)}](${escapeMarkdownUrl(source.url)})`;
    });

    return `\n\nSources:\n${rows.join('\n')}`;
}

export function collectUrlCitationSources(response: unknown): SourceLink[] {
    if (!response || typeof response !== 'object') return [];

    const output = (response as { output?: unknown }).output;
    if (!Array.isArray(output)) return [];

    const sources: SourceLink[] = [];
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
                    sources.push({
                        url: candidate.url,
                        title:
                            typeof candidate.title === 'string'
                                ? candidate.title
                                : undefined,
                    });
                }
            }
        }
    }

    return sources;
}
