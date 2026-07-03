import type { CourierAIMessage } from '@courierai/shared';

export const CITE_SENTINEL = String.fromCharCode(0xe000);

export interface CitationSourceView {
    sourceId: string;
    num: number;
    kind: 'url' | 'document';
    url?: string;
    title?: string;
    linkable: boolean;
    hash?: string;
}

export interface CitationMarkerRef {
    num: number;
    url?: string;
    tooltip: string;
    doc?: { hash: string; page?: number };
}

export interface CitationAnchor {
    pos: number;
    refs: CitationMarkerRef[];
}

export interface CitationView {
    sources: CitationSourceView[];
    anchors: CitationAnchor[];
}

function sourceTooltip(
    source: CitationSourceView,
    citedText: string | undefined,
    location: { kind: 'page' | 'char'; start: number; end: number } | undefined
): string {
    const name = source.title?.trim() || source.url || 'Document';
    const page =
        location?.kind === 'page'
            ? location.end - location.start > 1
                ? ` (p.${location.start}-${location.end - 1})`
                : ` (p.${location.start})`
            : '';
    const quote = citedText?.trim() ? `\n"${citedText.trim()}"` : '';
    return `${name}${page}${quote}`;
}

export function buildCitationView(msg: CourierAIMessage): CitationView {
    const sources: CitationSourceView[] = [];
    const sourceById = new Map<string, CitationSourceView>();
    for (const part of msg.parts) {
        if (part.type !== 'source-url' && part.type !== 'source-document')
            continue;
        if (sourceById.has(part.sourceId)) continue;
        const source: CitationSourceView =
            part.type === 'source-url'
                ? {
                      sourceId: part.sourceId,
                      num: sources.length + 1,
                      kind: 'url',
                      url: part.url,
                      title: part.title,
                      linkable: /^https?:\/\//i.test(part.url),
                  }
                : {
                      sourceId: part.sourceId,
                      num: sources.length + 1,
                      kind: 'document',
                      title: part.title,
                      linkable: false,
                      hash: part.hash,
                  };
        sources.push(source);
        sourceById.set(part.sourceId, source);
    }

    const texts: Array<{ offset: number; length: number }> = [];
    let offset = 0;
    for (const part of msg.parts) {
        if (part.type !== 'text') continue;
        texts.push({ offset, length: part.text.length });
        offset += part.text.length;
    }

    const anchorByPos = new Map<number, CitationAnchor>();
    for (const part of msg.parts) {
        if (part.type !== 'citation') continue;
        const source = sourceById.get(part.sourceId);
        if (!source) continue;
        const text = texts[part.textIndex];
        if (!text) continue;
        const end =
            part.textEnd < 0
                ? text.length
                : Math.min(part.textEnd, text.length);
        const pos = text.offset + end;
        let anchor = anchorByPos.get(pos);
        if (!anchor) {
            anchor = { pos, refs: [] };
            anchorByPos.set(pos, anchor);
        }
        if (anchor.refs.some((r) => r.num === source.num)) continue;
        anchor.refs.push({
            num: source.num,
            ...(source.linkable && source.url ? { url: source.url } : {}),
            tooltip: sourceTooltip(source, part.citedText, part.location),
            ...(source.hash
                ? {
                      doc: {
                          hash: source.hash,
                          ...(part.location?.kind === 'page'
                              ? { page: part.location.start }
                              : {}),
                      },
                  }
                : {}),
        });
    }

    const anchors = [...anchorByPos.values()].sort((a, b) => a.pos - b.pos);
    return { sources, anchors };
}

function unsafePositions(text: string): (pos: number) => boolean {
    const fences: Array<{ start: number; end: number }> = [];
    let inFence = false;
    let fenceStart = 0;
    let lineStart = 0;
    while (lineStart <= text.length) {
        const lineEnd = text.indexOf('\n', lineStart);
        const end = lineEnd === -1 ? text.length : lineEnd;
        if (text.slice(lineStart, end).trimStart().startsWith('```')) {
            if (inFence) {
                fences.push({ start: fenceStart, end });
                inFence = false;
            } else {
                inFence = true;
                fenceStart = lineStart;
            }
        }
        if (lineEnd === -1) break;
        lineStart = lineEnd + 1;
    }
    if (inFence) fences.push({ start: fenceStart, end: text.length });
    return (pos) => {
        for (const f of fences) {
            if (pos > f.start && pos < f.end) return true;
        }
        const ls = text.lastIndexOf('\n', pos - 1) + 1;
        let ticks = 0;
        for (let i = ls; i < pos; i++) {
            if (text.charCodeAt(i) === 96) ticks++;
        }
        return ticks % 2 === 1;
    };
}

export function spliceCitationMarkers(
    text: string,
    anchors: CitationAnchor[]
): string {
    if (!anchors.length) return text;
    const isUnsafe = unsafePositions(text);
    let out = text;
    for (let i = anchors.length - 1; i >= 0; i--) {
        const anchor = anchors[i];
        if (anchor.pos > text.length || !anchor.refs.length) continue;
        if (isUnsafe(anchor.pos)) continue;
        const token = `${CITE_SENTINEL}${i}:${anchor.refs
            .map((r) => r.num)
            .join(',')}${CITE_SENTINEL}`;
        out = out.slice(0, anchor.pos) + token + out.slice(anchor.pos);
    }
    return out;
}
