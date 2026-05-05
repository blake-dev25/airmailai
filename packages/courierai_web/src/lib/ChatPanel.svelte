<script lang="ts">
    import type { Attachment } from '@courier/shared';
    import { tick, untrack } from 'svelte';
    import Icon from './Icon.svelte';
    import MarkdownMessage from './MarkdownMessage.svelte';
    import { createSmoothText } from './smoothText.svelte';

    interface Message {
        role: 'user' | 'assistant';
        content: string;
        thinking?: string;
        attachments?: Attachment[];
    }

    let {
        messages,
        modelName,
        isStreaming = false,
        streamingLocally = false,
        chatWidth = 100,
        streamError = null,
        loading = false,
        smoothTextMode = 'smooth',
        submitKeystroke = 'enter',
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
        modelName: string;
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
            isAtBottom = true;
        },
    });

    $effect(() => {
        void smooth.display;
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
        isAtBottom = scrollHeight - scrollTop - clientHeight < 80;
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

    async function copyMessage(content: string) {
        await navigator.clipboard.writeText(content);
    }
</script>

<div class="chat-panel">
    <!-- System prompt -->
    <div class="system-section">
        <button
            type="button"
            class="system-header"
            onclick={() => (systemExpanded = !systemExpanded)}
        >
            <Icon
                name="chevron-down"
                class="chevron {systemExpanded ? 'expanded' : ''}"
            />
            <span>System Prompt</span>
            {#if systemPrompt.trim()}
                <span class="prompt-dot" aria-label="System prompt is set"
                ></span>
            {/if}
        </button>
        {#if demoMode}
            <button type="button" class="install-link">
                <span>Install the extension</span>
                <Icon name="external-link" />
            </button>
        {/if}
        {#if systemExpanded}
            <div class="system-body">
                <textarea
                    class="system-textarea"
                    placeholder="Give the model a persona, instructions, or context..."
                    bind:value={systemPrompt}
                ></textarea>
            </div>
        {/if}
    </div>

    <!-- Messages -->
    <div class="messages-wrapper">
        <div class="top-fade" class:visible={!isAtTop} aria-hidden="true"></div>
        <div
            class="messages"
            bind:this={messagesEl}
            onscroll={handleMessagesScroll}
        >
            <div
                class="messages-inner"
                style="max-width: min(100vw, calc(var(--narrow-chat-width) + (100vw - var(--narrow-chat-width)) * {chatWidth /
                    100}));"
            >
                {#if loading}
                    <div class="empty-state">
                        <p class="sub">Loading…</p>
                    </div>
                {:else if messages.length === 0}
                    <div class="empty-state">
                        <Icon name="mail-plus" />
                        <p>Start a conversation</p>
                        <p class="sub">
                            Choose a provider and model on the right, then type
                            below.
                        </p>
                    </div>
                {:else}
                    {#each messages as message, i (i)}
                        {@const isLastStreaming =
                            isStreaming && i === messages.length - 1}
                        <div
                            class="message"
                            class:user={message.role === 'user'}
                            data-msg-index={i}
                            role="group"
                            onmouseenter={() => setHovered(i)}
                            onmouseleave={() => setHovered(null)}
                        >
                            {#if message.role === 'user'}
                                <div class="user-group">
                                    {#if message.attachments?.length}
                                        <div class="attachment-chips">
                                            {#each message.attachments as att}
                                                <span class="attachment-chip"
                                                    >{att.name}</span
                                                >
                                            {/each}
                                        </div>
                                    {/if}
                                    {#if editingIndex === i}
                                        <textarea
                                            class="edit-textarea"
                                            style={editingDims
                                                ? `width: ${editingDims.w}px; min-height: ${editingDims.h}px;`
                                                : ''}
                                            bind:value={editingText}
                                        ></textarea>
                                        <div class="edit-btns">
                                            <button
                                                type="button"
                                                class="edit-save"
                                                onclick={saveEdit}>Save</button
                                            >
                                            <button
                                                type="button"
                                                class="edit-cancel"
                                                onclick={cancelEdit}
                                                >Cancel</button
                                            >
                                        </div>
                                    {:else if message.content}
                                        <div class="bubble">
                                            {message.content}
                                        </div>
                                    {/if}
                                    {#if hoveredIndex === i && editingIndex !== i}
                                        <div class="msg-actions">
                                            <button
                                                type="button"
                                                class="msg-action-btn"
                                                onclick={() => onretry(i)}
                                                disabled={isStreaming}
                                                aria-label="Retry"
                                            >
                                                <Icon name="retry" />
                                            </button>
                                            <button
                                                type="button"
                                                class="msg-action-btn"
                                                onclick={(e) =>
                                                    startEdit(
                                                        i,
                                                        message.content,
                                                        (
                                                            e.currentTarget as HTMLElement
                                                        )
                                                            .closest(
                                                                '.user-group',
                                                            )
                                                            ?.querySelector(
                                                                '.bubble',
                                                            ) as HTMLElement | null,
                                                    )}
                                                disabled={isStreaming}
                                                aria-label="Edit"
                                            >
                                                <Icon name="edit" />
                                            </button>
                                            <button
                                                type="button"
                                                class="msg-action-btn"
                                                onclick={() =>
                                                    copyMessage(
                                                        message.content,
                                                    )}
                                                aria-label="Copy"
                                            >
                                                <Icon name="copy" />
                                            </button>
                                            <button
                                                type="button"
                                                class="msg-action-btn"
                                                onclick={() => ondelete(i)}
                                                disabled={isStreaming}
                                                aria-label="Delete"
                                            >
                                                <Icon name="trash" />
                                            </button>
                                        </div>
                                    {/if}
                                </div>
                            {:else}
                                {@const msgContent =
                                    i === messages.length - 1 &&
                                    message.role === 'assistant' &&
                                    (isStreaming ||
                                        smooth.display !== message.content)
                                        ? smooth.display
                                        : message.content}
                                <div class="assistant-group">
                                    {#if isStreaming && i === messages.length - 1 && !message.content && !message.thinking}
                                        <div class="waiting-spinner">
                                            <Icon name="spinner" size={16} />
                                        </div>
                                    {/if}
                                    {#if message.thinking}
                                        <div class="thinking-block">
                                            <button
                                                type="button"
                                                class="thinking-toggle"
                                                onclick={() => {
                                                    const next = new Set(
                                                        expandedThinking,
                                                    );
                                                    if (next.has(i))
                                                        next.delete(i);
                                                    else next.add(i);
                                                    expandedThinking = next;
                                                }}
                                            >
                                                {#if isStreaming && i === messages.length - 1 && !message.content}
                                                    <Icon name="spinner" />
                                                {/if}
                                                <span>Thinking</span>
                                                <Icon
                                                    name="chevron-right"
                                                    class="thinking-chevron {expandedThinking.has(
                                                        i,
                                                    )
                                                        ? 'expanded'
                                                        : ''}"
                                                />
                                            </button>
                                            {#if expandedThinking.has(i)}
                                                <div class="thinking-content">
                                                    {message.thinking}
                                                </div>
                                            {/if}
                                        </div>
                                    {/if}
                                    {#if editingIndex === i}
                                        <textarea
                                            class="edit-textarea"
                                            style={editingDims
                                                ? `width: ${editingDims.w}px; min-height: ${editingDims.h}px;`
                                                : ''}
                                            bind:value={editingText}
                                        ></textarea>
                                        <div class="edit-btns">
                                            <button
                                                type="button"
                                                class="edit-save"
                                                onclick={saveEdit}>Save</button
                                            >
                                            <button
                                                type="button"
                                                class="edit-cancel"
                                                onclick={cancelEdit}
                                                >Cancel</button
                                            >
                                        </div>
                                    {:else if msgContent}
                                        <div class="bubble">
                                            <MarkdownMessage
                                                content={msgContent}
                                            />
                                        </div>
                                    {/if}
                                    {#if hoveredIndex === i && editingIndex !== i && !isLastStreaming}
                                        <div class="msg-actions">
                                            <button
                                                type="button"
                                                class="msg-action-btn"
                                                onclick={() => onretry(i)}
                                                disabled={isStreaming}
                                                aria-label="Retry"
                                            >
                                                <Icon name="retry" />
                                            </button>
                                            <button
                                                type="button"
                                                class="msg-action-btn"
                                                onclick={(e) =>
                                                    startEdit(
                                                        i,
                                                        message.content,
                                                        (
                                                            e.currentTarget as HTMLElement
                                                        )
                                                            .closest(
                                                                '.assistant-group',
                                                            )
                                                            ?.querySelector(
                                                                '.bubble',
                                                            ) as HTMLElement | null,
                                                    )}
                                                disabled={isStreaming}
                                                aria-label="Edit"
                                            >
                                                <Icon name="edit" />
                                            </button>
                                            <button
                                                type="button"
                                                class="msg-action-btn"
                                                onclick={() =>
                                                    copyMessage(
                                                        message.content,
                                                    )}
                                                aria-label="Copy"
                                            >
                                                <Icon name="copy" />
                                            </button>
                                            <button
                                                type="button"
                                                class="msg-action-btn"
                                                onclick={() => ondelete(i)}
                                                disabled={isStreaming}
                                                aria-label="Delete"
                                            >
                                                <Icon name="trash" />
                                            </button>
                                        </div>
                                    {/if}
                                </div>
                            {/if}
                        </div>
                    {/each}
                {/if}
            </div>
        </div>
        {#if !isAtBottom}
            <button
                type="button"
                class="scroll-bottom-btn"
                onclick={scrollToBottom}
                aria-label="Scroll to bottom"
            >
                <Icon name="chevron-down" />
            </button>
        {/if}
    </div>

    <!-- Stream error -->
    {#if streamError}
        <div class="stream-error" role="alert">{streamError}</div>
    {/if}

    <!-- Input -->
    <div class="input-wrapper">
        {#if pendingAttachments.length}
            <div class="file-tab-row">
                {#each pendingAttachments as att, i}
                    <div class="file-tab">
                        <Icon name="file" />
                        <span class="file-tab-name">{att.name}</span>
                        <button
                            type="button"
                            class="file-tab-remove"
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
        <div class="input-area">
            <input
                type="file"
                accept=".pdf,image/*"
                multiple
                class="file-input"
                bind:this={fileInputEl}
                onchange={handleFileChange}
            />
            <button
                type="button"
                class="attach-btn"
                onclick={openFilePicker}
                disabled={isStreaming ||
                    pendingAttachments.length >= MAX_ATTACHMENTS}
                aria-label="Attach file"
            >
                <Icon name="plus" />
            </button>
            <textarea
                class="input"
                placeholder="Message {modelName}…"
                rows="1"
                bind:value={inputText}
                bind:this={textareaEl}
                onkeydown={handleKeydown}
                oninput={autoResize}
            ></textarea>
            {#if isStreaming && streamingLocally}
                <button
                    type="button"
                    class="send-btn stop-btn"
                    onclick={stop}
                    aria-label="Stop"
                >
                    <Icon name="stop" />
                </button>
            {:else}
                <button
                    type="button"
                    class="send-btn"
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
    .chat-panel {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        background-color: var(--color-bg);
        min-width: 0;
    }

    /* System Prompt */
    .system-section {
        position: relative;
        flex-shrink: 0;
        background-color: var(--color-bg);
        border-bottom: 1px solid var(--color-border);
    }

    .install-link {
        position: absolute;
        top: 0;
        right: 16px;
        height: 44px;
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 0 8px;
        background: none;
        border: none;
        font-family: var(--font-sans);
        font-size: 0.75rem;
        font-weight: 500;
        color: var(--color-accent);
        cursor: pointer;
        border-radius: 4px;
        transition:
            color 0.15s,
            background-color 0.15s;
    }

    .install-link:hover {
        color: var(--color-accent-hover);
        text-decoration: underline;
    }

    .system-header {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        height: 44px;
        padding: 0 16px;
        background: none;
        border: none;
        font-size: 0.8125rem;
        font-weight: 500;
        color: var(--color-text);
        cursor: pointer;
        text-align: left;
        transition: color 0.1s;
        box-sizing: border-box;
    }

    .system-header:hover {
        color: var(--color-text);
    }

    .system-header :global(.chevron) {
        transition: transform 0.2s ease;
    }

    .system-header :global(.chevron.expanded) {
        transform: rotate(180deg);
    }

    .prompt-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background-color: var(--color-accent);
        flex-shrink: 0;
    }

    .system-body {
        padding: 0 16px 12px;
    }

    .system-textarea {
        width: 100%;
        min-height: 80px;
        max-height: 180px;
        padding: 10px 12px;
        background-color: var(--color-bg);
        border: 1px solid var(--color-border);
        border-radius: 8px;
        color: var(--color-text);
        font-family: var(--font-sans);
        font-size: 0.8125rem;
        line-height: 1.6;
        resize: vertical;
        box-sizing: border-box;
        transition: border-color 0.15s;
    }

    .system-textarea::placeholder {
        color: var(--color-text);
    }

    .system-textarea:focus {
        outline: none;
        border-color: var(--color-accent);
    }

    /* Messages */
    .top-fade {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: 64px;
        background: linear-gradient(to bottom, var(--color-bg), transparent);
        pointer-events: none;
        z-index: 2;
        opacity: 0;
        transition: opacity 0.2s ease;
    }

    .top-fade.visible {
        opacity: 1;
    }

    .messages-wrapper {
        flex: 1;
        position: relative;
        min-height: 0;
    }

    .scroll-bottom-btn {
        position: absolute;
        bottom: 16px;
        left: 50%;
        transform: translateX(-50%);
        display: flex;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 30px;
        background-color: var(--color-surface-sunken);
        border: 1px solid var(--color-border);
        border-radius: 50%;
        color: var(--color-text);
        cursor: pointer;
        z-index: 5;
        transition: background-color 0.15s;
        animation: fadeUp 0.15s ease;
    }

    .scroll-bottom-btn:hover {
        background-color: var(--color-border);
    }

    @keyframes fadeUp {
        from {
            opacity: 0;
            transform: translateX(-50%) translateY(6px);
        }
        to {
            opacity: 1;
            transform: translateX(-50%) translateY(0);
        }
    }

    .messages {
        height: 100%;
        overflow-y: auto;
    }

    .messages-inner {
        --narrow-chat-width: 744px;
        margin: 0 auto;
        padding: 28px 20px;
        display: flex;
        flex-direction: column;
        gap: 28px;
        min-height: 100%;
        box-sizing: border-box;
    }

    .messages::-webkit-scrollbar {
        width: 3px;
    }

    .messages::-webkit-scrollbar-track {
        background: transparent;
    }

    .messages::-webkit-scrollbar-thumb {
        background-color: var(--color-border);
        border-radius: 3px;
    }

    .empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        flex: 1;
        height: 100%;
        gap: 10px;
        color: var(--color-text);
    }

    .empty-state p {
        margin: 0;
        font-size: 0.9375rem;
        font-weight: 500;
        color: var(--color-text);
    }

    .empty-state .sub {
        font-size: 0.8125rem;
        font-weight: 400;
        text-align: center;
        max-width: 280px;
    }

    .message {
        display: flex;
        justify-content: flex-start;
    }

    .message.user {
        justify-content: flex-end;
    }

    .bubble {
        max-width: 70%;
        padding: 10px 14px;
        border-radius: 14px;
        font-size: 0.875rem;
        line-height: 1.65;
        white-space: pre-wrap;
        word-break: break-word;
        background-color: var(--color-surface-sunken);
        color: var(--color-text);
        border-bottom-left-radius: 4px;
    }

    .user-group .bubble {
        max-width: 100%;
        background-color: var(--color-accent-2);
        color: var(--color-surface-sunken);
        border-bottom-left-radius: 14px;
        border-bottom-right-radius: 4px;
    }

    .assistant-group .bubble {
        max-width: 100%;
    }

    /* Assistant message group (thinking + bubble stacked) */
    /* Right edge stays anchored to the narrow chat's right edge; left edge expands as the chat widens */
    .assistant-group {
        display: flex;
        flex-direction: column;
        gap: 8px;
        max-width: calc(50% + var(--narrow-chat-width) / 2);
        position: relative;
    }

    /* Thinking block */
    .thinking-block {
        border: 1px solid var(--color-border);
        border-radius: 8px;
        overflow: hidden;
    }

    .thinking-toggle {
        display: flex;
        align-items: center;
        gap: 6px;
        width: 100%;
        padding: 6px 10px;
        background: none;
        border: none;
        color: var(--color-text);
        font-family: var(--font-sans);
        font-size: 0.75rem;
        font-weight: 500;
        opacity: 0.6;
        cursor: pointer;
        text-align: left;
        transition: opacity 0.15s;
    }

    .thinking-toggle:hover {
        opacity: 1;
    }

    .thinking-toggle :global(.thinking-chevron) {
        transition: transform 0.2s ease;
    }

    .thinking-toggle :global(.thinking-chevron.expanded) {
        transform: rotate(90deg);
    }

    .thinking-content {
        padding: 8px 10px 10px;
        border-top: 1px solid var(--color-border);
        font-size: 0.75rem;
        line-height: 1.6;
        color: var(--color-text);
        opacity: 0.7;
        white-space: pre-wrap;
        word-break: break-word;
    }

    .waiting-spinner {
        display: flex;
        align-items: center;
        padding: 10px 14px;
        color: var(--color-text-muted);
    }

    /* User group (attachment chips + bubble) */
    /* Left edge stays anchored to the narrow chat's user-bubble left edge (80% from left); right edge expands as the chat widens */
    .user-group {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 6px;
        max-width: calc(50% + var(--narrow-chat-width) * 0.3);
        position: relative;
    }

    .attachment-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        justify-content: flex-end;
    }

    .attachment-chip {
        display: inline-flex;
        align-items: center;
        padding: 4px 10px;
        background-color: var(--color-accent-2);
        color: var(--color-surface-sunken);
        border-radius: 8px;
        font-size: 0.75rem;
        font-weight: 500;
        max-width: 240px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    /* Message action buttons */
    .msg-actions {
        position: absolute;
        top: calc(100% + 2px);
        display: flex;
        flex-direction: row;
        gap: 1px;
        animation: actionsAppear 0.1s ease both;
        z-index: 1;
    }

    .user-group .msg-actions {
        right: 0;
    }

    .assistant-group .msg-actions {
        left: 0;
    }

    @keyframes actionsAppear {
        from {
            opacity: 0;
            transform: translateY(2px);
        }
        to {
            opacity: 1;
            transform: translateY(0);
        }
    }

    .msg-action-btn {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        padding: 0;
        background: none;
        border: none;
        border-radius: 6px;
        color: var(--color-text);
        opacity: 0.4;
        cursor: pointer;
        transition:
            opacity 0.12s,
            background-color 0.12s;
    }

    .msg-action-btn::after {
        content: attr(aria-label);
        position: absolute;
        bottom: calc(100% + 5px);
        left: 50%;
        transform: translateX(-50%);
        background: var(--color-surface-raised);
        color: var(--color-text);
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

    .msg-action-btn:hover:not(:disabled) {
        opacity: 1;
        background-color: var(--color-surface-sunken);
    }

    .msg-action-btn:disabled {
        opacity: 0.18;
        cursor: not-allowed;
    }

    /* Edit mode */
    .edit-textarea {
        width: 100%;
        min-height: 60px;
        padding: 10px 14px;
        background-color: var(--color-bg);
        border: 1px solid var(--color-border);
        border-radius: 12px;
        color: var(--color-text);
        font-family: var(--font-sans);
        font-size: 0.875rem;
        line-height: 1.65;
        resize: vertical;
        box-sizing: border-box;
        transition: border-color 0.15s;
    }

    .edit-textarea:focus {
        outline: none;
        border-color: var(--color-accent);
    }

    .edit-btns {
        display: flex;
        gap: 6px;
    }

    .edit-save,
    .edit-cancel {
        padding: 5px 14px;
        border-radius: 8px;
        border: none;
        font-family: var(--font-sans);
        font-size: 0.8125rem;
        font-weight: 500;
        cursor: pointer;
        transition:
            opacity 0.15s,
            background-color 0.15s;
    }

    .edit-save {
        background-color: var(--color-accent-3, var(--color-accent));
        color: var(--color-bg);
    }

    .edit-save:hover {
        background-color: var(
            --color-accent-3-hover,
            var(--color-accent-hover)
        );
    }

    .edit-cancel {
        background-color: var(--color-surface-sunken);
        color: var(--color-text);
        border: 1px solid var(--color-border);
    }

    .edit-cancel:hover {
        background-color: var(--color-border);
    }

    /* Input wrapper (file tab + input row) */
    .input-wrapper {
        flex-shrink: 0;
        border-top: 1px solid var(--color-border);
        background-color: var(--color-bg);
    }

    /* File tab */
    .file-tab-row {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        padding: 8px 16px 0;
    }

    .file-tab {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 5px 8px 5px 10px;
        background-color: var(--color-surface-sunken);
        border: 1px solid var(--color-border);
        border-radius: 8px;
        font-size: 0.75rem;
        color: var(--color-text);
        max-width: 240px;
    }

    .file-tab-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 180px;
    }

    .file-tab-remove {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        background: none;
        border: none;
        padding: 0;
        color: var(--color-text);
        opacity: 0.5;
        cursor: pointer;
        flex-shrink: 0;
        transition: opacity 0.15s;
    }

    .file-tab-remove:hover {
        opacity: 1;
    }

    /* Input */
    .input-area {
        display: flex;
        align-items: flex-end;
        gap: 8px;
        padding: 12px 16px;
        background-color: var(--color-bg);
        flex-shrink: 0;
    }

    .file-input {
        display: none;
    }

    .attach-btn {
        width: calc(22px + 0.875rem * 1.5);
        height: calc(22px + 0.875rem * 1.5);
        display: flex;
        align-items: center;
        justify-content: center;
        background-color: var(--color-surface-sunken);
        color: var(--color-text);
        border: 1px solid var(--color-border);
        border-radius: 10px;
        cursor: pointer;
        flex-shrink: 0;
        transition:
            background-color 0.15s,
            opacity 0.15s;
    }

    .attach-btn:hover:not(:disabled) {
        background-color: var(--color-border);
    }

    .attach-btn:disabled {
        opacity: 0.35;
        cursor: not-allowed;
    }

    .input {
        flex: 1;
        max-height: 200px;
        padding: 10px 14px;
        background-color: var(--color-bg);
        border: 1px solid var(--color-border);
        border-radius: 10px;
        color: var(--color-text);
        font-family: var(--font-sans);
        font-size: 0.875rem;
        line-height: 1.5;
        resize: none;
        box-sizing: border-box;
        transition: border-color 0.15s;
    }

    .input::placeholder {
        color: var(--color-text);
    }

    .input:focus {
        outline: none;
        border-color: var(--color-accent);
    }

    .input::-webkit-scrollbar {
        display: none;
    }

    .send-btn {
        width: calc(22px + 0.875rem * 1.5);
        height: calc(22px + 0.875rem * 1.5);
        display: flex;
        align-items: center;
        justify-content: center;
        background-color: var(--color-accent-3, var(--color-accent));
        color: var(--color-bg);
        border: none;
        border-radius: 10px;
        cursor: pointer;
        flex-shrink: 0;
        transition:
            background-color 0.15s,
            opacity 0.15s;
    }

    .send-btn:hover:not(:disabled) {
        background-color: var(
            --color-accent-3-hover,
            var(--color-accent-hover)
        );
    }

    .send-btn:disabled {
        opacity: 0.35;
        cursor: not-allowed;
    }

    @keyframes searchFlash {
        0%,
        15% {
            box-shadow: 0 0 0 3px var(--color-accent);
            border-radius: 8px;
        }
        100% {
            box-shadow: 0 0 0 0 transparent;
        }
    }

    :global(.search-highlight) {
        animation: searchFlash 1.5s ease-out;
    }

    .stream-error {
        flex-shrink: 0;
        padding: 8px 16px;
        font-size: 0.8125rem;
        color: var(--color-accent);
        border-top: 1px solid var(--color-border);
        background-color: var(--color-bg);
    }
</style>
