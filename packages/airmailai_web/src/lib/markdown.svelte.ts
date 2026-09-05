import DOMPurify from 'dompurify';
import { marked, type TokenizerAndRendererExtension } from 'marked';
import markedFootnote from 'marked-footnote';
import type { HighlighterCore } from 'shiki/core';
import { type CitationAnchor, CITE_SENTINEL } from './citations';
import { escapeHtml } from './escapeHtml';
import { versionCheck } from './versionCheck.svelte';

const THEME = 'github-dark';

let highlighter: HighlighterCore | null = null;
let loadedLangs = new Set<string>();
let initPromise: Promise<void> | null = null;
let ready = $state(false);

export function isHighlighterReady(): boolean {
    return ready;
}

export function initMarkdown(): Promise<void> {
    if (highlighter) return Promise.resolve();
    if (!initPromise) {
        initPromise = import('./markdown-highlighter.js')
            .then(async (m) => {
                highlighter = await m.createMarkdownHighlighter();
                loadedLangs = new Set(highlighter.getLoadedLanguages());
                ready = true;
            })
            .catch((error) => {
                initPromise = null;
                versionCheck.reportAssetLoadFailure();
                throw error;
            });
    }
    return initPromise;
}

function inlineExtension(
    name: string,
    delimiter: string,
    pattern: RegExp,
    tag: string
): TokenizerAndRendererExtension {
    return {
        name,
        level: 'inline',
        start(src) {
            return src.indexOf(delimiter);
        },
        tokenizer(src) {
            const match = pattern.exec(src);
            if (match) return { type: name, raw: match[0], text: match[1] };
        },
        renderer(token) {
            return `<${tag}>${escapeHtml(token.text)}</${tag}>`;
        },
    };
}

let citeAnchors: CitationAnchor[] = [];

const citePattern = new RegExp(
    `^${CITE_SENTINEL}(\\d+):[\\d,]*${CITE_SENTINEL}`
);

const citationExtension: TokenizerAndRendererExtension = {
    name: 'citation',
    level: 'inline',
    start(src) {
        return src.indexOf(CITE_SENTINEL);
    },
    tokenizer(src) {
        const match = citePattern.exec(src);
        if (match) return { type: 'citation', raw: match[0], text: match[1] };
    },
    renderer(token) {
        const anchor = citeAnchors[Number(token.text)];
        if (!anchor) return '';
        const markers = anchor.refs
            .map((r) => {
                if (r.url) {
                    return `<a class="cite-marker" href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(r.tooltip)}">${r.num}</a>`;
                }
                if (r.doc) {
                    const page = r.doc.page
                        ? ` data-cite-page="${r.doc.page}"`
                        : '';
                    return `<button type="button" class="cite-marker" data-cite-hash="${escapeHtml(r.doc.hash)}"${page} title="${escapeHtml(r.tooltip)}">${r.num}</button>`;
                }
                return `<span class="cite-marker" title="${escapeHtml(r.tooltip)}">${r.num}</span>`;
            })
            .join('');
        return `<sup class="cite-group">${markers}</sup>`;
    },
};

marked.use(markedFootnote());
marked.use({
    extensions: [
        inlineExtension('highlight', '==', /^==([^=]+)==/, 'mark'),
        inlineExtension('superscript', '^', /^\^([^^\s]+)\^/, 'sup'),
        inlineExtension('subscript', '~', /^~([^~\s]+)~/, 'sub'),
        citationExtension,
    ],
});
marked.use({
    renderer: {
        code({ text, lang }) {
            if (highlighter) {
                const language = lang && loadedLangs.has(lang) ? lang : 'text';
                const highlighted = highlighter.codeToHtml(text, {
                    lang: language,
                    theme: THEME,
                });
                const langLabel = lang
                    ? `<span class="code-lang">${escapeHtml(lang)}</span>`
                    : '';
                const copyBtn = `<button type="button" class="code-copy" aria-label="Copy code">Copy</button>`;
                return `<div class="code-block"><div class="code-header">${langLabel}${copyBtn}</div>${highlighted}</div>`;
            }
            return `<pre><code>${escapeHtml(text)}</code></pre>`;
        },
        html({ text }) {
            return escapeHtml(text);
        },
        image({ href, title, text }) {
            const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
            return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"${titleAttr}>${escapeHtml(text || href)}</a>`;
        },
    },
});

export function renderMarkdown(
    text: string,
    citations?: CitationAnchor[]
): string {
    citeAnchors = citations ?? [];
    const html = marked.parse(text) as string;
    return DOMPurify.sanitize(html, {
        ADD_ATTR: ['target'],
        FORBID_TAGS: ['img'],
    });
}
