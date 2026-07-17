import type { CitationAnchor } from './citations';
import { reportAppError } from './errorStore.svelte';
import { getFileBlob } from './extension';
import { openBlobInNewTab } from './files';
import { advanceFence, type FenceState } from './markdown-fences';
import { renderMarkdown } from './markdown.svelte';

export interface StreamingMarkdownParams {
    content: string;
    highlighterReady: boolean;
    citations?: CitationAnchor[];
}

export function streamingMarkdown(
    node: HTMLDivElement,
    initial: StreamingMarkdownParams
) {
    let params = initial;
    let stableSource = '';
    let lastHighlighterReady = initial.highlighterReady;
    let scanLineStart = 0;
    let scanFence: FenceState | null = null;
    let latestSplit = 0;

    const headEl = document.createElement('div');
    const tailEl = document.createElement('div');
    node.appendChild(headEl);
    node.appendChild(tailEl);

    function resetScan() {
        scanLineStart = 0;
        scanFence = null;
        latestSplit = 0;
    }

    function advanceScan(content: string) {
        let i = content.indexOf('\n', scanLineStart);
        while (i !== -1) {
            const line = content.slice(scanLineStart, i);
            if (line === '' && scanFence === null && scanLineStart > 0) {
                latestSplit = i + 1;
            }
            scanFence = advanceFence(scanFence, line);
            scanLineStart = i + 1;
            i = content.indexOf('\n', scanLineStart);
        }
    }

    function sync() {
        if (!params.content.startsWith(stableSource)) {
            stableSource = '';
            headEl.innerHTML = '';
            resetScan();
        } else if (scanLineStart > params.content.length) {
            resetScan();
        }

        if (
            params.highlighterReady &&
            !lastHighlighterReady &&
            stableSource &&
            headEl.querySelector('pre code')
        ) {
            headEl.innerHTML = renderMarkdown(stableSource, params.citations);
        }
        lastHighlighterReady = params.highlighterReady;

        advanceScan(params.content);
        if (latestSplit > stableSource.length) {
            const newSlice = params.content.slice(
                stableSource.length,
                latestSplit
            );
            headEl.insertAdjacentHTML(
                'beforeend',
                renderMarkdown(newSlice, params.citations)
            );
            stableSource = params.content.slice(0, latestSplit);
        }

        const tail = params.content.slice(stableSource.length);
        tailEl.innerHTML = tail ? renderMarkdown(tail, params.citations) : '';
    }

    function onClick(e: MouseEvent) {
        const cite = (e.target as Element).closest(
            'button.cite-marker[data-cite-hash]'
        ) as HTMLButtonElement | null;
        if (cite) {
            const hash = cite.dataset.citeHash ?? '';
            const page = Number(cite.dataset.citePage);
            getFileBlob(hash)
                .then((blob) => {
                    if (!blob) {
                        throw new Error('file not found in local storage');
                    }
                    openBlobInNewTab(
                        blob.mediaType,
                        blob.base64,
                        Number.isFinite(page) && page > 0 ? page : undefined
                    );
                })
                .catch((err) => {
                    reportAppError(
                        'citation document open failed',
                        "Couldn't open the cited document",
                        err
                    );
                });
            return;
        }
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
