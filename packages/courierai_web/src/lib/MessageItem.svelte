<script lang="ts">
    import Icon from './Icon.svelte';
    import MarkdownMessage from './MarkdownMessage.svelte';
    import type { Message } from './types';

    let {
        message,
        index,
        displayContent,
        isStreaming,
        isLastStreaming,
        editing,
        editingText = $bindable(),
        editingDims,
        hovered,
        thinkingExpanded,
        onhoverenter,
        onhoverleave,
        onstartedit,
        onsaveedit,
        oncanceledit,
        onthinkingtoggle,
        onretry,
        ondelete,
    }: {
        message: Message;
        index: number;
        displayContent: string;
        isStreaming: boolean;
        isLastStreaming: boolean;
        editing: boolean;
        editingText: string;
        editingDims: { w: number; h: number } | null;
        hovered: boolean;
        thinkingExpanded: boolean;
        onhoverenter: () => void;
        onhoverleave: () => void;
        onstartedit: (content: string, bubbleEl: HTMLElement | null) => void;
        onsaveedit: () => void;
        oncanceledit: () => void;
        onthinkingtoggle: () => void;
        onretry: () => void;
        ondelete: () => void;
    } = $props();

    let bubbleEl = $state<HTMLElement | null>(null);

    const isUser = $derived(message.role === 'user');

    async function copyMessage(content: string) {
        await navigator.clipboard.writeText(content);
    }

    const bubbleBase =
        'max-w-full px-3.5 py-2.5 rounded-[14px] text-sm leading-[1.65] whitespace-pre-wrap wrap-break-word';
    const bubbleAssistant = `${bubbleBase} bg-bubble-assistant text-on-bubble-assistant rounded-bl-[4px]`;
    const bubbleUser = `${bubbleBase} bg-bubble-user text-on-bubble-user rounded-br-[4px]`;

    const msgActionBtnClass =
        'msg-action-btn relative flex items-center justify-center w-6 h-6 p-0 bg-transparent border-0 rounded-md text-fg opacity-40 cursor-pointer transition-[opacity,background-color] duration-[120ms] enabled:hover:opacity-100 enabled:hover:bg-surface-sunken disabled:opacity-[0.18] disabled:cursor-not-allowed';

    const editTextareaClass =
        'w-full min-h-15 px-3.5 py-2.5 bg-canvas border border-border rounded-xl text-fg font-sans text-sm leading-[1.65] resize-y box-border outline-none transition-[border-color] duration-150 focus:border-accent-fg';

    const editBtnBase =
        'px-3.5 py-1.25 rounded-lg border-0 font-sans text-sm font-medium cursor-pointer transition-[background-color,color,opacity] duration-150';
</script>

<div
    class={['flex', isUser ? 'justify-end' : 'justify-start']}
    data-msg-index={index}
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
        ]}
    >
        {#if isUser}
            {#if message.attachments?.length}
                <div class="flex flex-wrap gap-1.5 justify-end">
                    {#each message.attachments as att}
                        <span
                            class="inline-flex items-center px-2.5 py-1 bg-bubble-user text-on-bubble-user rounded-lg text-xs font-medium max-w-60 overflow-hidden text-ellipsis whitespace-nowrap"
                            >{att.name}</span
                        >
                    {/each}
                </div>
            {/if}
        {:else}
            {#if isLastStreaming && !message.content && !message.thinking}
                <div class="flex items-center px-3.5 py-2.5 text-fg-muted">
                    <Icon name="spinner" size={16} />
                </div>
            {/if}
            {#if message.thinking}
                <div class="border border-border rounded-lg overflow-hidden">
                    <button
                        type="button"
                        class="flex items-center gap-1.5 w-full px-2.5 py-1.5 bg-transparent border-0 text-fg font-sans text-xs font-medium opacity-60 cursor-pointer text-left transition-opacity duration-150 hover:opacity-100"
                        onclick={onthinkingtoggle}
                    >
                        {#if isLastStreaming && !message.content}
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
                            {message.thinking}
                        </div>
                    {/if}
                </div>
            {/if}
        {/if}

        {#if editing}
            <textarea
                class={editTextareaClass}
                style={editingDims
                    ? `width: ${editingDims.w}px; min-height: ${editingDims.h}px;`
                    : ''}
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
            <div
                bind:this={bubbleEl}
                class={isUser ? bubbleUser : bubbleAssistant}
            >
                {#if isUser}
                    {message.content}
                {:else}
                    <MarkdownMessage content={displayContent} />
                {/if}
            </div>
        {/if}

        {#if hovered && !editing && !isLastStreaming}
            <div
                class={[
                    'absolute top-full mt-0.5 flex flex-row gap-px animate-actions-appear z-1',
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
                    onclick={() => onstartedit(message.content, bubbleEl)}
                    disabled={isStreaming}
                    aria-label="Edit"
                >
                    <Icon name="edit" />
                </button>
                <button
                    type="button"
                    class={msgActionBtnClass}
                    onclick={() => copyMessage(message.content)}
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
