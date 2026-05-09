<script lang="ts">
    import type { Attachment } from '@courier/shared';
    import { tick, untrack } from 'svelte';
    import Icon from './Icon.svelte';
    import MessageItem from './MessageItem.svelte';
    import { createSmoothText } from './smoothText.svelte';
    import type { Message } from './types';

    let {
        messages,
        isStreaming = false,
        streamingLocally = false,
        chatWidth = 100,
        streamError = null,
        loading = false,
        smoothTextMode = 'smooth',
        submitKeystroke = 'enter',
        autoscroll = false,
        systemPrompt = $bindable(),
        highlightMessageIndex = null,
        demoMode = false,
        onsend,
        onstop,
        onretry,
        onedit,
        ondelete,
        onextensionneeded,
    }: {
        messages: Message[];
        // True if any tab is streaming this chat (local or remote).
        isStreaming?: boolean;
        // True only when *this* tab owns the stream — gates the stop button,
        // since stop only works against the source tab's port.
        streamingLocally?: boolean;
        chatWidth?: number;
        streamError?: string | null;
        loading?: boolean;
        smoothTextMode?:
            | 'smooth'
            | 'boost-on-complete'
            | 'dump-on-complete'
            | 'raw';
        submitKeystroke?: 'enter' | 'ctrl+enter';
        autoscroll?: boolean;
        systemPrompt: string;
        highlightMessageIndex?: number | null;
        demoMode?: boolean;
        onsend: (content: string, attachments?: Attachment[]) => void;
        onstop: (truncatedContent: string) => void;
        onretry: (index: number) => void;
        onedit: (index: number, content: string) => void;
        ondelete: (index: number) => void;
        onextensionneeded: () => void;
    } = $props();

    let systemExpanded = $state(false);
    let expandedThinking = $state(new Set<number>());
    let inputText = $state('');
    let messagesEl = $state<HTMLElement | null>(null);
    let lastScrollTop = 0;
    let textareaEl = $state<HTMLTextAreaElement | null>(null);
    let fileInputEl = $state<HTMLInputElement | null>(null);
    let isAtBottom = $state(true);
    let isAtTop = $state(true);
    let pendingAttachments = $state<Attachment[]>([]);
    let hoveredIndex = $state<number | null>(null);
    let hoverHideTimer: ReturnType<typeof setTimeout> | null = null;
    let editingIndex = $state<number | null>(null);
    let editingText = $state('');
    let editingDims = $state<{ w: number; h: number } | null>(null);

    const MAX_ATTACHMENTS = 20;

    const smooth = createSmoothText({
        mode: () => smoothTextMode,
        streaming: () => untrack(() => isStreaming),
        onReset: () => {
            if (autoscroll) isAtBottom = true;
        },
    });

    $effect(() => {
        void smooth.display;
        if (!untrack(() => autoscroll)) return;
        tick().then(() => {
            if (messagesEl && untrack(() => isAtBottom))
                messagesEl.scrollTop = messagesEl.scrollHeight;
        });
    });

    $effect(() => {
        const raw = messages[messages.length - 1]?.content ?? '';
        smooth.setRaw(raw);
        return () => smooth.cancel();
    });

    // dump-on-complete: when the stream ends, snap any remaining un-drained text to the screen.
    $effect(() => {
        if (smoothTextMode !== 'dump-on-complete') return;
        if (isStreaming) return;
        smooth.flushIfComplete();
    });

    $effect(() => {
        const idx = highlightMessageIndex;
        if (idx == null) return;
        let cancelled = false;
        tick().then(() => {
            requestAnimationFrame(() => {
                if (cancelled || !messagesEl) return;
                const el = messagesEl.querySelector(
                    `[data-msg-index="${idx}"]`,
                ) as HTMLElement | null;
                if (!el) return;
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                el.classList.add('search-highlight');
                setTimeout(() => el.classList.remove('search-highlight'), 1500);
            });
        });
        return () => {
            cancelled = true;
        };
    });

    $effect(() => {
        if (editingIndex !== null && editingIndex >= messages.length) {
            editingIndex = null;
            editingText = '';
        }
    });

    function handleMessagesScroll() {
        if (!messagesEl) return;
        const { scrollTop, scrollHeight, clientHeight } = messagesEl;
        // Any upward movement immediately pauses autoscroll — no threshold fight
        if (scrollTop < lastScrollTop) {
            isAtBottom = false;
        } else {
            isAtBottom = scrollHeight - scrollTop - clientHeight < 80;
        }
        lastScrollTop = scrollTop;
        isAtTop = scrollTop < 20;
    }

    function scrollToBottom() {
        if (!messagesEl) return;
        isAtBottom = true;
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function handleKeydown(e: KeyboardEvent) {
        const shouldSubmit =
            submitKeystroke === 'ctrl+enter'
                ? e.key === 'Enter' && e.ctrlKey
                : e.key === 'Enter' && !e.shiftKey;
        if (shouldSubmit) {
            e.preventDefault();
            submit();
        }
    }

    function submit() {
        const text = inputText.trim();
        if ((!text && !pendingAttachments.length) || isStreaming) return;
        if (demoMode) {
            onextensionneeded();
            return;
        }
        isAtBottom = true;
        const atts = pendingAttachments;
        pendingAttachments = [];
        onsend(text, atts.length ? atts : undefined);
        inputText = '';
        if (textareaEl) textareaEl.style.height = '';
    }

    // Stop the current stream. Pass smooth.display so the saved/visible text
    // matches exactly what the user sees — characters queued in the smooth
    // drain are discarded rather than rushed onto the screen.
    function stop() {
        onstop(smooth.display);
    }

    function openFilePicker() {
        fileInputEl?.click();
    }

    function handleFileChange(e: Event) {
        const files = Array.from((e.target as HTMLInputElement).files ?? []);
        if (!fileInputEl) return;
        fileInputEl.value = '';
        if (!files.length) return;

        const slots = MAX_ATTACHMENTS - pendingAttachments.length;
        const toAdd = files.slice(0, slots);

        for (const file of toAdd) {
            const reader = new FileReader();
            reader.onload = () => {
                const dataUrl = reader.result as string;
                const comma = dataUrl.indexOf(',');
                const data = dataUrl.slice(comma + 1);
                pendingAttachments = [
                    ...pendingAttachments,
                    { name: file.name, mediaType: file.type, data },
                ];
            };
            reader.readAsDataURL(file);
        }
    }

    function autoResize(e: Event) {
        const ta = e.target as HTMLTextAreaElement;
        ta.style.height = 'auto';
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    }

    function startEdit(
        i: number,
        content: string,
        bubbleEl?: HTMLElement | null,
    ) {
        editingDims = bubbleEl
            ? { w: bubbleEl.offsetWidth, h: bubbleEl.offsetHeight }
            : null;
        editingIndex = i;
        editingText = content;
    }

    function saveEdit() {
        if (editingIndex === null) return;
        onedit(editingIndex, editingText);
        editingIndex = null;
        editingText = '';
    }

    function cancelEdit() {
        editingIndex = null;
        editingText = '';
    }

    function setHovered(i: number | null) {
        if (hoverHideTimer !== null) {
            clearTimeout(hoverHideTimer);
            hoverHideTimer = null;
        }
        if (i === null) {
            hoverHideTimer = setTimeout(() => {
                hoveredIndex = null;
                hoverHideTimer = null;
            }, 120);
        } else {
            hoveredIndex = i;
        }
    }

    const sendStyleBase =
        'w-[calc(22px+0.875rem*1.5)] h-[calc(22px+0.875rem*1.5)] flex items-center justify-center rounded-lg border-0 cursor-pointer shrink-0 transition-[background-color,color,opacity] duration-150';
</script>

<div class="flex-1 flex flex-col overflow-hidden bg-canvas min-w-0">
    <!-- System prompt -->
    <div class="relative shrink-0 bg-canvas border-b border-border">
        <button
            type="button"
            class="flex items-center gap-2 w-full h-11 px-4 bg-transparent border-0 text-sm font-medium text-fg cursor-pointer text-left transition-[color] duration-100 box-border"
            onclick={() => (systemExpanded = !systemExpanded)}
        >
            <Icon
                name="chevron-down"
                class="transition-transform duration-200 {systemExpanded
                    ? 'rotate-180'
                    : ''}"
            />
            <span>System Prompt</span>
            {#if systemPrompt.trim()}
                <span
                    class="w-1.5 h-1.5 rounded-full bg-accent-bg shrink-0"
                    aria-label="System prompt is set"
                ></span>
            {/if}
        </button>
        {#if demoMode}
            <button
                type="button"
                class="absolute top-0 right-4 h-11 flex items-center gap-1.25 px-2 bg-transparent border-0 font-sans text-xs font-medium text-accent-fg cursor-pointer rounded transition-[color,background-color] duration-150 hover:text-accent-fg-hover hover:underline"
            >
                <span>Install the extension</span>
                <Icon name="external-link" />
            </button>
        {/if}
        {#if systemExpanded}
            <div class="px-4 pb-3">
                <textarea
                    class="w-full min-h-20 max-h-45 px-3 py-2.5 bg-canvas border border-border rounded-lg text-fg font-sans text-sm leading-[1.6] resize-y box-border outline-none transition-[border-color] duration-150 focus:border-accent-fg placeholder:text-fg-muted"
                    placeholder="Give the model a persona, instructions, or context..."
                    bind:value={systemPrompt}
                ></textarea>
            </div>
        {/if}
    </div>

    <!-- Messages -->
    <div class="flex-1 relative min-h-0">
        <div
            class="absolute top-0 left-0 right-0 h-16 bg-linear-to-b from-canvas to-transparent pointer-events-none z-2 transition-opacity duration-200 {!isAtTop
                ? 'opacity-100'
                : 'opacity-0'}"
            aria-hidden="true"
        ></div>
        <div
            class="messages-scroll h-full overflow-y-auto"
            bind:this={messagesEl}
            onscroll={handleMessagesScroll}
        >
            <div
                class="[--narrow-chat-width:744px] mx-auto px-5 py-7 flex flex-col gap-7 min-h-full box-border"
                style="max-width: min(100vw, calc(744px + (100vw - 744px) * {chatWidth /
                    100}));"
            >
                {#if loading}
                    <div
                        class="flex flex-col items-center justify-center flex-1 h-full gap-2.5 text-fg"
                    >
                        <p
                            class="text-[0.8125rem] font-normal text-center max-w-70"
                        >
                            Loading...
                        </p>
                    </div>
                {:else if messages.length === 0}
                    <div
                        class="flex flex-col items-center justify-center flex-1 h-full gap-2.5 text-fg"
                    >
                        <Icon name="mail-plus" />
                        <p
                            class="text-[0.9375rem] font-medium text-fg m-0"
                        >
                            Start a conversation
                        </p>
                        <p
                            class="text-[0.8125rem] font-normal text-center max-w-70 m-0"
                        >
                            Choose a provider and model on the right, then type
                            below.
                        </p>
                    </div>
                {:else}
                    {#each messages as message, i (i)}
                        {@const isLastStreaming =
                            isStreaming && i === messages.length - 1}
                        {@const displayContent =
                            i === messages.length - 1 &&
                            message.role === 'assistant' &&
                            (isStreaming ||
                                smooth.display !== message.content)
                                ? smooth.display
                                : message.content}
                        <MessageItem
                            {message}
                            index={i}
                            {displayContent}
                            {isStreaming}
                            {isLastStreaming}
                            editing={editingIndex === i}
                            bind:editingText
                            {editingDims}
                            hovered={hoveredIndex === i}
                            thinkingExpanded={expandedThinking.has(i)}
                            onhoverenter={() => setHovered(i)}
                            onhoverleave={() => setHovered(null)}
                            onstartedit={(content, bubbleEl) =>
                                startEdit(i, content, bubbleEl)}
                            onsaveedit={saveEdit}
                            oncanceledit={cancelEdit}
                            onthinkingtoggle={() => {
                                const next = new Set(expandedThinking);
                                if (next.has(i)) next.delete(i);
                                else next.add(i);
                                expandedThinking = next;
                            }}
                            onretry={() => onretry(i)}
                            ondelete={() => ondelete(i)}
                        />
                    {/each}
                {/if}
            </div>
        </div>
        {#if !isAtBottom}
            <button
                type="button"
                class="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center justify-center w-7.5 h-7.5 bg-surface-sunken border border-border rounded-full text-fg cursor-pointer z-5 transition-[background-color] duration-150 animate-fade-up hover:bg-border"
                onclick={scrollToBottom}
                aria-label="Scroll to bottom"
            >
                <Icon name="chevron-down" />
            </button>
        {/if}
    </div>

    <!-- Stream error -->
    {#if streamError}
        <div
            class="shrink-0 px-4 py-2 text-sm text-accent-fg border-t border-border bg-canvas"
            role="alert"
        >
            {streamError}
        </div>
    {/if}

    <!-- Input -->
    <div class="shrink-0 border-t border-border bg-canvas">
        {#if pendingAttachments.length}
            <div class="flex flex-wrap gap-1 px-4 pt-2">
                {#each pendingAttachments as att, i}
                    <div
                        class="inline-flex items-center gap-1.5 pl-2.5 pr-2 py-1.25 bg-surface-sunken border border-border rounded-lg text-xs text-fg max-w-60"
                    >
                        <Icon name="file" />
                        <span
                            class="overflow-hidden text-ellipsis whitespace-nowrap max-w-45"
                            >{att.name}</span
                        >
                        <button
                            type="button"
                            class="flex items-center justify-center w-4 h-4 bg-transparent border-0 p-0 text-fg opacity-50 cursor-pointer shrink-0 transition-opacity duration-150 hover:opacity-100"
                            onclick={() =>
                                (pendingAttachments = pendingAttachments.filter(
                                    (_, j) => j !== i,
                                ))}
                            aria-label="Remove attachment"
                        >
                            <Icon name="close" />
                        </button>
                    </div>
                {/each}
            </div>
        {/if}
        <div
            class="flex items-end gap-2 px-4 py-3 bg-canvas shrink-0"
        >
            <input
                type="file"
                accept=".pdf,image/*"
                multiple
                class="hidden"
                bind:this={fileInputEl}
                onchange={handleFileChange}
            />
            <button
                type="button"
                class="{sendStyleBase} bg-surface-sunken text-fg border! border-border! enabled:hover:bg-border disabled:opacity-[0.35] disabled:cursor-not-allowed"
                onclick={openFilePicker}
                disabled={isStreaming ||
                    pendingAttachments.length >= MAX_ATTACHMENTS}
                aria-label="Attach file"
            >
                <Icon name="plus" />
            </button>
            <textarea
                class="flex-1 max-h-50 px-3.5 py-2.5 bg-canvas border border-border rounded-lg text-fg font-sans text-sm leading-normal resize-none box-border outline-none transition-[border-color] duration-150 focus:border-accent-fg placeholder:text-fg-muted [&::-webkit-scrollbar]:hidden"
                placeholder="Write a message"
                rows="1"
                bind:value={inputText}
                bind:this={textareaEl}
                onkeydown={handleKeydown}
                oninput={autoResize}
            ></textarea>
            {#if isStreaming && streamingLocally}
                <button
                    type="button"
                    class="{sendStyleBase} bg-accent-3-bg text-on-accent-3-bg hover:bg-accent-3-bg-hover hover:text-on-accent-3-bg-hover"
                    onclick={stop}
                    aria-label="Stop"
                >
                    <Icon name="stop" />
                </button>
            {:else}
                <button
                    type="button"
                    class="{sendStyleBase} bg-accent-3-bg text-on-accent-3-bg enabled:hover:bg-accent-3-bg-hover enabled:hover:text-on-accent-3-bg-hover disabled:opacity-[0.35] disabled:cursor-not-allowed"
                    onclick={submit}
                    disabled={isStreaming ||
                        (!inputText.trim() && !pendingAttachments.length)}
                    aria-label="Send message"
                >
                    <Icon name="send" />
                </button>
            {/if}
        </div>
    </div>
</div>

<style>
    .messages-scroll::-webkit-scrollbar {
        width: 3px;
    }
    .messages-scroll::-webkit-scrollbar-track {
        background: transparent;
    }
    .messages-scroll::-webkit-scrollbar-thumb {
        background-color: var(--color-border);
        border-radius: 3px;
    }
</style>
