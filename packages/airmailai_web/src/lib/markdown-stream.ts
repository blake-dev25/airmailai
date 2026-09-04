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
    streaming: boolean;
    deferred: boolean;
}

const THROTTLED_TAIL_RENDER_INTERVAL_MS = 100;
const SLOW_TAIL_RENDER_MS = 4;
const RENDER_CACHE_MAX_ENTRIES = 200;

const renderCache = new Map<string, string>();

function cachedRender(content: string): string | undefined {
    const html = renderCache.get(content);
    if (html === undefined) return undefined;
    renderCache.delete(content);
    renderCache.set(content, html);
    return html;
}

function rememberRender(content: string, html: string): void {
    renderCache.set(content, html);
    if (renderCache.size <= RENDER_CACHE_MAX_ENTRIES) return;
    const oldest = renderCache.keys().next().value;
    if (oldest !== undefined) renderCache.delete(oldest);
}

const deferredRenders: Array<() => void> = [];
let idleHandle: number | null = null;

function scheduleIdle(callback: (deadline: IdleDeadline) => void): number {
    if (typeof requestIdleCallback === 'function') {
        return requestIdleCallback(callback);
    }
    return window.setTimeout(
        () => callback({ didTimeout: true, timeRemaining: () => 0 }),
        0
    );
}

function drainDeferredRenders(deadline: IdleDeadline): void {
    idleHandle = null;
    do {
        const render = deferredRenders.pop();
        if (!render) return;
        render();
    } while (deadline.timeRemaining() > 0 && deferredRenders.length > 0);
    if (deferredRenders.length > 0)
        idleHandle = scheduleIdle(drainDeferredRenders);
}

function enqueueDeferredRender(render: () => void): void {
    deferredRenders.push(render);
    if (idleHandle === null) idleHandle = scheduleIdle(drainDeferredRenders);
}

function dequeueDeferredRender(render: () => void): void {
    const index = deferredRenders.indexOf(render);
    if (index >= 0) deferredRenders.splice(index, 1);
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
    let lastTailRenderAt = 0;
    let tailSlow = false;
    let tailTimer: ReturnType<typeof setTimeout> | null = null;
    let rendered = false;

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
            const nextFence = advanceFence(scanFence, line);
            if (scanFence !== null && nextFence === null) {
                latestSplit = i + 1;
            }
            scanFence = nextFence;
            scanLineStart = i + 1;
            i = content.indexOf('\n', scanLineStart);
        }
    }

    function cancelTailTimer() {
        if (tailTimer === null) return;
        clearTimeout(tailTimer);
        tailTimer = null;
    }

    function renderTail() {
        cancelTailTimer();
        lastTailRenderAt = performance.now();
        const tail = params.content.slice(stableSource.length);
        tailEl.innerHTML = tail ? renderMarkdown(tail, params.citations) : '';
        tailSlow = performance.now() - lastTailRenderAt > SLOW_TAIL_RENDER_MS;
    }

    function renderTailThrottled() {
        const elapsed = performance.now() - lastTailRenderAt;
        if (elapsed >= THROTTLED_TAIL_RENDER_INTERVAL_MS) {
            renderTail();
            return;
        }
        if (tailTimer !== null) return;
        tailTimer = setTimeout(
            renderTail,
            THROTTLED_TAIL_RENDER_INTERVAL_MS - elapsed
        );
    }

    function isCacheable(): boolean {
        return (
            !params.streaming &&
            !params.citations?.length &&
            (params.highlighterReady || !params.content.includes('```'))
        );
    }

    function renderWhole() {
        const content = params.content;
        let html = cachedRender(content);
        if (html === undefined) {
            html = renderMarkdown(content, params.citations);
            if (isCacheable()) rememberRender(content, html);
        }
        headEl.innerHTML = html;
        tailEl.innerHTML = '';
        stableSource = content;
        scanLineStart = content.length;
        scanFence = null;
        latestSplit = content.length;
        tailSlow = false;
        lastHighlighterReady = params.highlighterReady;
    }

    function sync() {
        rendered = true;
        if (!params.content.startsWith(stableSource)) {
            stableSource = '';
            headEl.innerHTML = '';
            resetScan();
        } else if (scanLineStart > params.content.length) {
            resetScan();
        }

        if (!params.streaming && stableSource === '') {
            renderWhole();
            return;
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
            tailSlow = false;
        }

        if (params.streaming && (scanFence !== null || tailSlow)) {
            renderTailThrottled();
        } else {
            renderTail();
        }
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
                        blob,
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

    const deferredRender = () => sync();

    node.addEventListener('click', onClick);
    if (initial.deferred && !initial.streaming) {
        enqueueDeferredRender(deferredRender);
    } else {
        sync();
    }

    return {
        update(next: StreamingMarkdownParams) {
            params = next;
            if (!rendered) {
                if (next.streaming) {
                    dequeueDeferredRender(deferredRender);
                    sync();
                }
                return;
            }
            sync();
        },
        destroy() {
            cancelTailTimer();
            dequeueDeferredRender(deferredRender);
            node.removeEventListener('click', onClick);
        },
    };
}
