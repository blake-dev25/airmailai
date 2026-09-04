<script lang="ts">
    import type { CitationAnchor } from './citations';
    import { reportAppError } from './errorStore.svelte';
    import { initMarkdown, isHighlighterReady } from './markdown.svelte';
    import { streamingMarkdown } from './markdown-stream';

    let {
        content,
        citations,
        streaming = false,
        deferred = false,
    }: {
        content: string;
        citations?: CitationAnchor[];
        streaming?: boolean;
        deferred?: boolean;
    } = $props();

    let hasCodeBlock = $derived(content.includes('```'));

    $effect(() => {
        if (hasCodeBlock && !isHighlighterReady()) {
            initMarkdown().catch((err) => {
                reportAppError(
                    'syntax highlighter load failed',
                    "Couldn't load syntax highlighter",
                    err
                );
            });
        }
    });
</script>

<div
    class="prose prose-sm max-w-none font-(family-name:--font-message)"
    use:streamingMarkdown={{
        content,
        highlighterReady: isHighlighterReady(),
        citations,
        streaming,
        deferred,
    }}
></div>

<style>
    :global(.prose .code-block) {
        position: relative;
        margin-top: 0.5em;
        margin-bottom: 0.5em;
    }

    :global(.prose .code-header) {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding-bottom: 2px;
    }

    :global(.prose .code-lang) {
        display: inline-block;
        font-family: var(--font-mono);
        font-size: 0.7rem;
        font-style: normal;
        color: var(--color-fg-muted);
        padding: 0 2px;
    }

    :global(.prose .code-copy) {
        background: none;
        border: 1px solid var(--color-border);
        border-radius: 4px;
        color: var(--color-fg-muted);
        cursor: pointer;
        font-family: var(--font-mono);
        font-size: 0.7rem;
        line-height: 1;
        padding: 2px 7px;
        transition:
            color 0.1s,
            border-color 0.1s;
    }

    :global(.prose .code-copy:hover) {
        border-color: var(--color-fg-muted);
        color: var(--color-fg);
    }

    :global(.prose > div:first-child:not(:empty) > :first-child),
    :global(.prose > div:first-child:empty + div > :first-child) {
        margin-top: 0;
    }
    :global(.prose > div:last-child:not(:empty) > :last-child),
    :global(.prose > div:first-child:has(+ div:empty) > :last-child) {
        margin-bottom: 0;
    }

    :global(.prose pre) {
        background-color: var(--color-surface-sunken);
        border: 1px solid var(--color-border);
        margin-top: 0;
        margin-bottom: 0;
    }

    :global(.prose code:not(pre code)) {
        background-color: var(--color-surface-sunken);
        border: 1px solid var(--color-border);
        border-radius: 4px;
        padding: 1px 5px;
        font-size: 0.8125em;
    }

    :global(.prose code:not(pre code))::before,
    :global(.prose code:not(pre code))::after {
        content: none;
    }

    :global(.prose blockquote) {
        border-left-color: var(--color-accent-fg);
        color: var(--color-fg-muted);
    }

    :global(.prose a) {
        color: var(--color-accent-fg);
    }
    :global(.prose hr) {
        border-color: var(--color-border);
    }

    :global(.prose thead) {
        border-bottom-color: var(--color-border);
    }
    :global(.prose tbody tr) {
        border-bottom-color: var(--color-border);
    }

    :global(.prose mark) {
        background-color: color-mix(
            in srgb,
            var(--color-accent-bg) 25%,
            transparent
        );
        color: inherit;
        border-radius: 2px;
        padding: 0 2px;
    }

    :global(.prose .footnotes) {
        margin-top: 1em;
        padding-top: 0.5em;
        border-top: 1px solid var(--color-border);
        font-size: 0.8em;
        color: var(--color-fg-muted);
    }

    :global(.prose .cite-group) {
        display: inline-flex;
        gap: 3px;
        margin-left: 1px;
        line-height: 1;
        vertical-align: super;
        font-size: 0.7em;
    }

    :global(.prose .cite-marker) {
        background: none;
        border: none;
        padding: 0;
        font: inherit;
        line-height: inherit;
        color: var(--color-fg-muted);
        font-weight: 500;
        text-decoration: none;
        cursor: default;
        transition: color 0.1s;
    }

    :global(.prose a.cite-marker),
    :global(.prose button.cite-marker) {
        cursor: pointer;
    }

    :global(.prose a.cite-marker:hover),
    :global(.prose button.cite-marker:hover) {
        color: var(--color-accent-fg);
    }
</style>
