import DOMPurify from 'dompurify';
import { marked, type TokenizerAndRendererExtension } from 'marked';
import markedFootnote from 'marked-footnote';
import type { HighlighterCore } from 'shiki/core';

const THEME = 'github-dark';

let highlighter: HighlighterCore | null = null;
let initPromise: Promise<void> | null = null;
let ready = $state(false);

export function isHighlighterReady(): boolean {
    return ready;
}

export function initMarkdown(): Promise<void> {
    if (highlighter) return Promise.resolve();
    if (!initPromise) {
        initPromise = import('./markdown-highlighter.js').then(async (m) => {
            highlighter = await m.createMarkdownHighlighter();
            ready = true;
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
            return `<${tag}>${token.text}</${tag}>`;
        },
    };
}

marked.use(markedFootnote());
marked.use({
    extensions: [
        inlineExtension('highlight', '==', /^==([^=]+)==/, 'mark'),
        inlineExtension('superscript', '^', /^\^([^^\s]+)\^/, 'sup'),
        inlineExtension('subscript', '~', /^~([^~\s]+)~/, 'sub'),
    ],
});
marked.use({
    renderer: {
        code({ text, lang }) {
            if (highlighter) {
                const loadedLangs = highlighter.getLoadedLanguages();
                const language =
                    lang && (loadedLangs as readonly string[]).includes(lang)
                        ? lang
                        : 'text';
                const highlighted = highlighter.codeToHtml(text, {
                    lang: language,
                    theme: THEME,
                });
                const langLabel = lang
                    ? `<span class="code-lang">${lang
                          .replace(/&/g, '&amp;')
                          .replace(/</g, '&lt;')
                          .replace(/>/g, '&gt;')}</span>`
                    : '';
                const copyBtn = `<button type="button" class="code-copy" aria-label="Copy code">Copy</button>`;
                return `<div class="code-block"><div class="code-header">${langLabel}${copyBtn}</div>${highlighted}</div>`;
            }
            const escaped = text
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
            return `<pre><code>${escaped}</code></pre>`;
        },
        html({ text }) {
            return text
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
        },
    },
});

export function renderMarkdown(text: string): string {
    const html = marked.parse(text) as string;
    return DOMPurify.sanitize(html);
}
