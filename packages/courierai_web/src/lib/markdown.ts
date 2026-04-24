import DOMPurify from 'dompurify';
import { marked, type TokenizerAndRendererExtension } from 'marked';
import markedFootnote from 'marked-footnote';
import { createHighlighter, type Highlighter } from 'shiki';

const THEME = 'github-dark';

const LANGUAGES = [
    'javascript',
    'typescript',
    'jsx',
    'tsx',
    'python',
    'bash',
    'sh',
    'json',
    'html',
    'css',
    'markdown',
    'sql',
    'rust',
    'go',
    'java',
    'cpp',
    'c',
    'yaml',
    'toml',
];

let highlighter: Highlighter | null = null;
let initPromise: Promise<void> | null = null;

export function isHighlighterReady(): boolean {
    return highlighter !== null;
}

export function initMarkdown(): Promise<void> {
    if (highlighter) return Promise.resolve();
    if (!initPromise) {
        initPromise = createHighlighter({
            themes: [THEME],
            langs: LANGUAGES,
        }).then((h) => {
            highlighter = h;
        });
    }
    return initPromise;
}

// Kick off loading immediately on module import
initMarkdown();

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
        inlineExtension('superscript', '^', /^\^([^^]+)\^/, 'sup'),
        inlineExtension('subscript', '~', /^~([^~]+)~/, 'sub'),
    ],
});
marked.use({
    renderer: {
        code({ text, lang }) {
            if (highlighter) {
                const loadedLangs = highlighter.getLoadedLanguages();
                const language =
                    lang && loadedLangs.includes(lang as never) ? lang : 'text';
                const highlighted = highlighter.codeToHtml(text, {
                    lang: language,
                    theme: THEME,
                });
                const langLabel = lang
                    ? `<span class="code-lang">${lang}</span>`
                    : '';
                const copyBtn = `<button type="button" class="code-copy" aria-label="Copy code">Copy</button>`;
                return `<div class="code-block"><div class="code-header">${langLabel}${copyBtn}</div>${highlighted}</div>`;
            }
            // Fallback while highlighter is still loading
            const escaped = text
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
            return `<pre><code>${escaped}</code></pre>`;
        },
        // Escape raw HTML from the LLM — show it as text, not rendered DOM
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
