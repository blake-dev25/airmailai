import { reportAppError } from './errorStore.svelte';
import { renderMarkdown } from './markdown.svelte';

export interface StreamingMarkdownParams {
    content: string;
    // When the lazy-loaded Shiki highlighter flips ready mid-stream, head
    // needs a one-time re-render to fold syntax highlighting into any code
    // blocks that promoted out of the tail before Shiki was available.
    highlighterReady: boolean;
}

// Svelte action - owns the entirety of `node`'s children. The component
// template must be `<div use:streamingMarkdown={...}></div>` with no inner
// content; Svelte never tries to reconcile the subtree, so direct innerHTML
// + appendChild here is safe.
//
// Two-region layout: a "head" of completed markdown blocks that never
// re-renders (so already-displayed content doesn't layout-shift as the
// stream grows), and a "tail" that re-renders on every update for the
// in-progress portion. Content moves from tail -> head when a paragraph
// boundary (\n\n outside any open ``` fence) is found. Per markdown spec,
// tables also end at a blank line, so \n\n is safe with respect to tables
// too - once a table closes it gets promoted whole.
//
// Trade-off: head is rendered via slice-then-append, so reference-style
// links / footnote definitions that span the head/tail boundary will not
// resolve. LLM output rarely uses these, and on stream end the full content
// can still be re-rendered if we want correctness - but for now we accept
// the limitation for the layout-stability win.
export function streamingMarkdown(
    node: HTMLDivElement,
    initial: StreamingMarkdownParams
) {
    let params = initial;
    // The exact prefix of `params.content` we've rendered into headEl. Stored
    // (not just its length) so we can detect content swap-outs from chat
    // switches / edits with a single startsWith check.
    let stableSource = '';
    let lastHighlighterReady = initial.highlighterReady;

    const headEl = document.createElement('div');
    const tailEl = document.createElement('div');
    node.appendChild(headEl);
    node.appendChild(tailEl);

    function sync() {
        // Content swap (chat switch, message edit, retry) - start over.
        if (!params.content.startsWith(stableSource)) {
            stableSource = '';
            headEl.innerHTML = '';
        }

        // Shiki just loaded and head has code blocks that rendered via the
        // unhighlighted fallback - re-render head once to fold in syntax
        // colors. Idempotent if all blocks were already highlighted.
        if (
            params.highlighterReady &&
            !lastHighlighterReady &&
            stableSource &&
            headEl.querySelector('pre code')
        ) {
            headEl.innerHTML = renderMarkdown(stableSource);
        }
        lastHighlighterReady = params.highlighterReady;

        // Promote any newly-completed blocks from tail into head.
        const candidate = findSafeSplit(params.content, stableSource.length);
        if (candidate > stableSource.length) {
            const newSlice = params.content.slice(
                stableSource.length,
                candidate
            );
            headEl.insertAdjacentHTML('beforeend', renderMarkdown(newSlice));
            stableSource = params.content.slice(0, candidate);
        }

        const tail = params.content.slice(stableSource.length);
        tailEl.innerHTML = tail ? renderMarkdown(tail) : '';
    }

    function onClick(e: MouseEvent) {
        const btn = (e.target as Element).closest(
            '.code-copy'
        ) as HTMLButtonElement | null;
        if (!btn) return;
        const pre = btn.closest('.code-block')?.querySelector('pre');
        if (!pre) return;
        navigator.clipboard
            .writeText(pre.textContent ?? '')
            .then(() => {
                btn.textContent = 'Copied!';
                setTimeout(() => {
                    btn.textContent = 'Copy';
                }, 2000);
            })
            .catch((err) => {
                reportAppError(
                    'clipboard write failed',
                    "Couldn't copy to clipboard",
                    err
                );
            });
    }

    node.addEventListener('click', onClick);
    sync();

    return {
        update(next: StreamingMarkdownParams) {
            params = next;
            sync();
        },
        destroy() {
            node.removeEventListener('click', onClick);
        },
    };
}

// Return the largest position > `after` in `content` that is safe to use as
// the head/tail boundary: just past a blank line (\n\n) that is NOT inside
// an open ``` fence. Linear scan from start so we can track fence state;
// cost is negligible vs the marked + DOMPurify pass that renderMarkdown
// runs on the resulting slices.
function findSafeSplit(content: string, after: number): number {
    let inFence = false;
    let latestSplit = after;
    let lineStart = 0;

    for (let i = 0; i < content.length; i++) {
        if (content[i] !== '\n') continue;

        const line = content.slice(lineStart, i);

        // Blank line (\n followed by \n). Skip the document's leading blank
        // - lineStart === 0 means this is the first newline, not the second
        // of a pair.
        if (line === '' && !inFence && lineStart > 0) {
            const boundary = i + 1;
            if (boundary > after) latestSplit = boundary;
        }

        if (line.startsWith('```')) inFence = !inFence;

        lineStart = i + 1;
    }

    return latestSplit;
}
