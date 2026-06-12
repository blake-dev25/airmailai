<script lang="ts">
    import type { FileAvailability } from '@courierai/shared';
    import { reportAppError } from './errorStore.svelte';
    import { getFileBlob } from './extension';
    import { formatFileSize, triggerBlobDownload } from './files';
    import Icon from './Icon.svelte';
    import MarkdownMessage from './MarkdownMessage.svelte';
    import {
        messageCodeExecutions,
        messageThinking,
        type Message,
    } from './types';

    let {
        message,
        index,
        messageContent,
        displayContent,
        fileStatuses = {},
        isStreaming,
        isLastStreaming,
        editing,
        editingText = $bindable(),
        editingDims,
        hovered,
        thinkingExpanded,
        sourcesExpanded,
        codeExpanded,
        onhoverenter,
        onhoverleave,
        onstartedit,
        onsaveedit,
        oncanceledit,
        onthinkingtoggle,
        onsourcestoggle,
        oncodetoggle,
        onretry,
        ondelete,
        ondeletefile,
    }: {
        message: Message;
        index: number;
        messageContent: string;
        displayContent: string;
        fileStatuses?: Record<string, FileAvailability>;
        isStreaming: boolean;
        isLastStreaming: boolean;
        editing: boolean;
        editingText: string;
        editingDims: { h: number } | null;
        hovered: boolean;
        thinkingExpanded: boolean;
        sourcesExpanded: boolean;
        codeExpanded: boolean;
        onhoverenter: () => void;
        onhoverleave: () => void;
        onstartedit: (content: string, bubbleEl: HTMLElement | null) => void;
        onsaveedit: () => void;
        oncanceledit: () => void;
        onthinkingtoggle: () => void;
        onsourcestoggle: () => void;
        oncodetoggle: () => void;
        onretry: () => void;
        ondelete: () => void;
        ondeletefile: (key: string) => void;
    } = $props();

    let bubbleEl = $state<HTMLElement | null>(null);

    interface ChipModel {
        key: string;
        filename: string;
        sizeBytes: number;
        mediaType: string;
        hash: string;
    }

    const isUser = $derived(message.role === 'user');
    const chips = $derived.by(() => {
        const out: ChipModel[] = [];
        const seen = new Set<string>();
        for (const part of message.parts) {
            if (part.type !== 'file') continue;
            if (seen.has(part.hash)) continue;
            seen.add(part.hash);
            out.push({
                key: part.hash,
                filename: part.filename,
                sizeBytes: part.sizeBytes,
                mediaType: part.mediaType,
                hash: part.hash,
            });
        }
        return out;
    });

    function chipStatus(c: ChipModel): FileAvailability {
        return fileStatuses[c.hash] ?? 'local';
    }

    function chipUnavailableText(status: FileAvailability): string | null {
        if (status === 'expired') {
            return "This file's provider copy has expired and it will not be sent with future messages.";
        }
        if (status === 'missing') {
            return 'This file has been deleted and will not be sent with future messages.';
        }
        return null;
    }
    const thinking = $derived(messageThinking(message));
    const codeExecutions = $derived(messageCodeExecutions(message));

    const stopNotice = $derived.by(() => {
        if (message.role !== 'assistant') return null;
        switch (message.metadata?.stopReason) {
            case 'length':
                return 'Response truncated (max tokens reached)';
            case 'refusal':
                return 'Model declined to continue';
            case 'content-filter':
                return 'Stopped by content filter';
            default:
                return null;
        }
    });

    const flatSources = $derived.by(() => {
        const seen = new Set<string>();
        const out: { url: string; title?: string }[] = [];
        for (const part of message.parts) {
            if (part.type !== 'source-url') continue;
            if (!part.url || seen.has(part.url)) continue;
            seen.add(part.url);
            out.push({ url: part.url, title: part.title });
        }
        return out;
    });

    const docCitations = $derived.by(() => {
        const out: Array<{
            title: string;
            citedText?: string;
            startPage?: number;
            endPage?: number;
        }> = [];
        for (const part of message.parts) {
            if (part.type !== 'source-document') continue;
            const isPage = part.location?.kind === 'page';
            out.push({
                title: part.title ?? '',
                citedText: part.citedText,
                startPage: isPage ? part.location?.start : undefined,
                endPage: isPage ? part.location?.end : undefined,
            });
        }
        return out;
    });

    async function copyMessage(content: string) {
        await navigator.clipboard.writeText(content);
    }

    async function downloadChip(chip: ChipModel) {
        try {
            const blob = await getFileBlob(chip.hash);
            if (!blob) {
                throw new Error('file not found in local storage');
            }
            triggerBlobDownload(chip.filename, blob.mediaType, blob.base64);
        } catch (err) {
            reportAppError(
                'file download failed',
                `Couldn't download ${chip.filename}`,
                err
            );
        }
    }

    const bubbleBase =
        'max-w-full px-3.5 py-2.5 rounded-[14px] text-sm leading-[1.65] wrap-break-word';
    const bubbleAssistant = `${bubbleBase} bg-bubble-assistant text-on-bubble-assistant rounded-bl-[4px]`;
    const bubbleUser = `${bubbleBase} whitespace-pre-wrap bg-bubble-user text-on-bubble-user rounded-br-[4px]`;

    const msgActionBtnClass =
        'msg-action-btn relative flex items-center justify-center w-6 h-6 p-0 bg-transparent border-0 rounded-md text-fg opacity-40 cursor-pointer transition-[opacity,background-color] duration-[120ms] enabled:hover:opacity-100 enabled:hover:bg-surface-sunken disabled:opacity-[0.18] disabled:cursor-not-allowed';

    const editTextareaClass =
        'w-full min-h-15 px-3.5 py-2.5 bg-canvas border border-border rounded-xl text-fg font-sans text-sm leading-[1.65] resize-y box-border outline-none transition-[border-color] duration-150 focus:border-accent-fg';

    const editBtnBase =
        'px-3.5 py-1.25 rounded-lg border-0 font-sans text-sm font-medium cursor-pointer transition-[background-color,color,opacity] duration-150';

    const expandoBtnClass =
        'flex items-center gap-1.5 w-full bg-transparent border-0 text-on-bubble-assistant font-sans text-xs font-medium opacity-60 cursor-pointer text-left transition-opacity duration-150 hover:opacity-100';
    const codePreClass =
        'm-0 px-2.5 py-2 bg-canvas border border-border rounded-md font-mono text-xs leading-normal overflow-x-auto whitespace-pre-wrap wrap-break-word';
    const codeLabelClass = 'text-[11px] font-medium opacity-50';
    const chipBtnClass =
        'flex items-center justify-center w-4 h-4 p-0 bg-transparent border-0 text-current opacity-50 cursor-pointer shrink-0 transition-opacity duration-150 hover:opacity-100';
</script>

{#snippet chip(c: ChipModel)}
    {@const status = chipStatus(c)}
    {@const unavailableText = chipUnavailableText(status)}
    <span
        class={[
            'inline-flex items-center gap-1.5 px-2.5 py-1 bg-canvas border rounded-lg text-xs max-w-full',
            unavailableText
                ? 'border-accent-fg/50 text-accent-fg'
                : 'border-border',
        ]}
        title={unavailableText}
    >
        <Icon name="file" />
        <span class="overflow-hidden text-ellipsis whitespace-nowrap max-w-45"
            >{c.filename}</span
        >
        {#if c.sizeBytes > 0}
            <span class="opacity-50">{formatFileSize(c.sizeBytes)}</span>
        {/if}
        {#if status === 'local'}
            <button
                type="button"
                class={chipBtnClass}
                title="Download {c.filename}"
                aria-label="Download {c.filename}"
                onclick={() => downloadChip(c)}
            >
                <Icon name="download" />
            </button>
        {/if}
        <button
            type="button"
            class={chipBtnClass}
            title="Remove {c.filename}"
            aria-label="Remove {c.filename}"
            onclick={() => ondeletefile(c.key)}
        >
            <Icon name="trash" />
        </button>
    </span>
{/snippet}

<div
    class={['flex', isUser ? 'justify-end' : 'justify-start']}
    data-msg-index={index}
    data-msg-role={message.role}
    role="group"
    onmouseenter={onhoverenter}
    onmouseleave={onhoverleave}
>
    <div
        class={[
            'flex flex-col relative',
            isUser
                ? 'items-end gap-1.5 max-w-[calc(50%+var(--narrow-chat-width)*0.3)]'
                : 'gap-2 max-w-[calc(50%+var(--narrow-chat-width)/2)]',
            editing && 'w-full max-w-full!',
        ]}
    >
        {#if isUser}
            {#if chips.length}
                <div class="flex flex-wrap gap-1.5 justify-end">
                    {#each chips as c (c.key)}
                        {@render chip(c)}
                    {/each}
                </div>
            {/if}
        {:else}
            {#if isLastStreaming && !messageContent && !thinking}
                <div class="flex items-center px-3.5 py-2.5 text-fg-muted">
                    <Icon name="spinner" size={16} />
                </div>
            {/if}
            {#if thinking}
                <div class="border border-border rounded-lg overflow-hidden">
                    <button
                        type="button"
                        class="flex items-center gap-1.5 w-full px-2.5 py-1.5 bg-transparent border-0 text-fg font-sans text-xs font-medium opacity-60 cursor-pointer text-left transition-opacity duration-150 hover:opacity-100"
                        onclick={onthinkingtoggle}
                    >
                        {#if isLastStreaming && !messageContent}
                            <Icon name="spinner" />
                        {/if}
                        <span>Thinking</span>
                        <Icon
                            name="chevron-right"
                            class="transition-transform duration-200 {thinkingExpanded
                                ? 'rotate-90'
                                : ''}"
                        />
                    </button>
                    {#if thinkingExpanded}
                        <div
                            class="px-2.5 pt-2 pb-2.5 border-t border-border text-xs leading-[1.6] text-fg opacity-70 whitespace-pre-wrap wrap-break-word"
                        >
                            {thinking}
                        </div>
                    {/if}
                </div>
            {/if}
        {/if}

        {#if editing}
            <textarea
                class={editTextareaClass}
                rows="1"
                style={editingDims ? `min-height: ${editingDims.h}px;` : ''}
                bind:value={editingText}
            ></textarea>
            <div class="flex gap-1.5">
                <button
                    type="button"
                    class="{editBtnBase} bg-accent-3-bg text-on-accent-3-bg hover:bg-accent-3-bg-hover hover:text-on-accent-3-bg-hover"
                    onclick={onsaveedit}>Save</button
                >
                <button
                    type="button"
                    class="{editBtnBase} bg-surface-sunken text-fg border! border-border! hover:bg-border"
                    onclick={oncanceledit}>Cancel</button
                >
            </div>
        {:else if displayContent}
            {#if isUser}
                <div bind:this={bubbleEl} class={bubbleUser}>
                    {messageContent}
                </div>
            {:else}
                <div bind:this={bubbleEl} class={bubbleAssistant}>
                    <MarkdownMessage content={displayContent} />
                    {#if docCitations.length}
                        <div class="mt-2 pt-2 border-t border-current/15">
                            <div
                                class="flex flex-wrap gap-1.5 text-xs leading-[1.4] opacity-80"
                            >
                                {#each docCitations as cite, i (i)}
                                    <span
                                        class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-current/20 max-w-full"
                                        title={cite.citedText ?? ''}
                                    >
                                        <Icon name="file" />
                                        <span
                                            class="overflow-hidden text-ellipsis whitespace-nowrap max-w-60"
                                            >{cite.title}{cite.startPage !==
                                            undefined
                                                ? cite.endPage !== undefined &&
                                                  cite.endPage !==
                                                      cite.startPage
                                                    ? ` p.${cite.startPage}-${cite.endPage}`
                                                    : ` p.${cite.startPage}`
                                                : ''}</span
                                        >
                                    </span>
                                {/each}
                            </div>
                        </div>
                    {/if}
                    {#if chips.length}
                        <div
                            class="mt-2 pt-2 border-t border-current/15 flex flex-wrap gap-1.5"
                        >
                            {#each chips as c (c.key)}
                                {@render chip(c)}
                            {/each}
                        </div>
                    {/if}
                    {#if codeExecutions.length}
                        <div class="mt-2 pt-2 border-t border-current/15">
                            <button
                                type="button"
                                class={expandoBtnClass}
                                onclick={oncodetoggle}
                            >
                                <span>Code</span>
                                <Icon
                                    name="chevron-right"
                                    class="transition-transform duration-200 {codeExpanded
                                        ? 'rotate-90'
                                        : ''}"
                                />
                            </button>
                            {#if codeExpanded}
                                <div class="mt-1.5 flex flex-col gap-2.5">
                                    {#each codeExecutions as ce (ce.id)}
                                        <div class="flex flex-col gap-1">
                                            {#if ce.code}
                                                <div class={codeLabelClass}>
                                                    Input
                                                </div>
                                                <pre class={codePreClass}><code
                                                        >{ce.code}</code
                                                    ></pre>
                                            {/if}
                                            {#if ce.stdout}
                                                <div class={codeLabelClass}>
                                                    Output
                                                </div>
                                                <pre class={codePreClass}><code
                                                        >{ce.stdout}</code
                                                    ></pre>
                                            {/if}
                                            {#if ce.stderr}
                                                <div
                                                    class="text-[11px] font-medium text-accent-fg"
                                                >
                                                    Error
                                                </div>
                                                <pre
                                                    class="m-0 px-2.5 py-2 bg-canvas border border-accent-fg/40 rounded-md font-mono text-xs leading-normal text-accent-fg overflow-x-auto whitespace-pre-wrap wrap-break-word"><code
                                                        >{ce.stderr}</code
                                                    ></pre>
                                            {/if}
                                            {#if ce.errorText}
                                                <div
                                                    class="text-[11px] text-accent-fg opacity-90"
                                                >
                                                    {ce.errorText}
                                                </div>
                                            {/if}
                                        </div>
                                    {/each}
                                </div>
                            {/if}
                        </div>
                    {/if}
                    {#if flatSources.length}
                        <div class="mt-2 pt-2 border-t border-current/15">
                            <button
                                type="button"
                                class={expandoBtnClass}
                                onclick={onsourcestoggle}
                            >
                                <span>Sources</span>
                                <Icon
                                    name="chevron-right"
                                    class="transition-transform duration-200 {sourcesExpanded
                                        ? 'rotate-90'
                                        : ''}"
                                />
                            </button>
                            {#if sourcesExpanded}
                                <ol
                                    class="mt-1.5 pl-5 text-xs leading-[1.6] opacity-80 list-decimal"
                                >
                                    {#each flatSources as source (source.url)}
                                        <li>
                                            <a
                                                href={source.url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                class="text-accent-fg hover:underline wrap-break-word"
                                                >{source.title?.trim() ||
                                                    source.url}</a
                                            >
                                        </li>
                                    {/each}
                                </ol>
                            {/if}
                        </div>
                    {/if}
                </div>
            {/if}
        {/if}

        {#if stopNotice && !isLastStreaming && !editing}
            <div class="flex items-center gap-1.5 px-1 text-xs text-fg-muted">
                <Icon name="info" />
                <span>{stopNotice}</span>
            </div>
        {/if}

        {#if hovered && !editing && !isLastStreaming}
            <div
                class={[
                    'absolute top-full mt-0.5 flex flex-row gap-px animate-actions-appear z-1 select-none',
                    isUser ? 'right-0' : 'left-0',
                ]}
            >
                <button
                    type="button"
                    class={msgActionBtnClass}
                    onclick={onretry}
                    disabled={isStreaming}
                    aria-label="Retry"
                >
                    <Icon name="retry" />
                </button>
                <button
                    type="button"
                    class={msgActionBtnClass}
                    onclick={() => onstartedit(messageContent, bubbleEl)}
                    disabled={isStreaming}
                    aria-label="Edit"
                >
                    <Icon name="edit" />
                </button>
                <button
                    type="button"
                    class={msgActionBtnClass}
                    onclick={() => copyMessage(messageContent)}
                    aria-label="Copy"
                >
                    <Icon name="copy" />
                </button>
                <button
                    type="button"
                    class={msgActionBtnClass}
                    onclick={ondelete}
                    disabled={isStreaming}
                    aria-label="Delete"
                >
                    <Icon name="trash" />
                </button>
            </div>
        {/if}
    </div>
</div>

<style>
    .msg-action-btn::after {
        content: attr(aria-label);
        position: absolute;
        bottom: calc(100% + 5px);
        left: 50%;
        transform: translateX(-50%);
        background: var(--color-surface-raised);
        color: var(--color-fg);
        border: 1px solid var(--color-border);
        padding: 2px 7px;
        border-radius: 5px;
        font-size: 11px;
        font-weight: 500;
        white-space: nowrap;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.1s;
        z-index: 10;
    }

    .msg-action-btn:hover:not(:disabled)::after {
        opacity: 1;
    }
</style>
