<script lang="ts">
    import type { Attachment } from '@courier/shared';
    import { tick, untrack } from 'svelte';
    import { appLifecycle } from './appLifecycle.svelte';
    import { chatStore } from './chatStore.svelte';
    import { errorStore } from './errorStore.svelte';
    import {
        formatFileSize,
        getAcceptForProvider,
        getFilePolicy,
        hashBytes,
        resolveFileMediaType,
        validateReadyAttachments,
    } from './files';
    import Icon from './Icon.svelte';
    import MessageItem from './MessageItem.svelte';
    import type { ModelOption } from './models';
    import { providersStore } from './providersStore.svelte';
    import { settingsStore } from './settingsStore.svelte';
    import { createSmoothText } from './smoothText.svelte';
    import { createStickToBottom } from './stickToBottom.svelte';

    let systemExpanded = $state(false);
    // Per-message UI state keyed by Message.id so it survives mid-chat deletes
    // (an index-keyed Set/index would shift onto the wrong message).
    let expandedThinking = $state(new Set<string>());
    let expandedSources = $state(new Set<string>());
    let inputText = $state('');
    let messagesEl = $state<HTMLElement | null>(null);
    let messagesContentEl = $state<HTMLElement | null>(null);
    let textareaEl = $state<HTMLTextAreaElement | null>(null);
    let fileInputEl = $state<HTMLInputElement | null>(null);
    let isAtTop = $state(true);
    let pendingAttachments = $state<Attachment[]>([]);
    let processingAttachments = $state<
        Array<{ id: string; name: string; progress: number }>
    >([]);
    let fileErrors = $state<string[]>([]);
    let lastFilePolicyKey: string | null = null;
    let hoveredMessageId = $state<string | null>(null);
    let hoverHideTimer: ReturnType<typeof setTimeout> | null = null;
    let editingMessageId = $state<string | null>(null);
    let editingText = $state('');
    let editingDims = $state<{ h: number } | null>(null);

    let uploadGeneration = 0;
    let filePolicy = $derived(
        getFilePolicy(settingsStore.providerId, providersStore.selectedModel)
    );
    let filePolicyKey = $derived(
        [
            filePolicy.providerId,
            filePolicy.maxAttachments,
            filePolicy.maxFileBytes,
            filePolicy.maxRequestBytes,
            filePolicy.maxAudioAttachments ?? '',
            filePolicy.maxVideoAttachments ?? '',
            ...Array.from(filePolicy.mimeTypes).sort(),
        ].join(':')
    );
    let fileAccept = $derived(
        getAcceptForProvider(
            settingsStore.providerId,
            providersStore.selectedModel
        )
    );
    let canAttachFiles = $derived(filePolicy.mimeTypes.size > 0);
    let attachmentTotalBytes = $derived(
        pendingAttachments.reduce(
            (total, attachment) => total + attachment.encodedSizeBytes,
            0
        )
    );

    const stick = createStickToBottom();

    const smooth = createSmoothText({
        mode: () => settingsStore.smoothTextMode,
        streaming: () => untrack(() => chatStore.isActiveStreaming),
        onReset: () => {
            if (untrack(() => settingsStore.autoscroll)) stick.reSticky();
        },
    });

    $effect(() => {
        if (!messagesEl || !messagesContentEl) return;
        return stick.attach(
            messagesEl,
            messagesContentEl,
            () => settingsStore.autoscroll
        );
    });

    $effect(() => {
        const raw =
            chatStore.activeMessages[chatStore.activeMessages.length - 1]
                ?.content ?? '';
        smooth.setRaw(raw);
        return () => smooth.cancel();
    });

    // dump-on-complete: when the stream ends, snap any remaining un-drained text to the screen.
    $effect(() => {
        if (settingsStore.smoothTextMode !== 'dump-on-complete') return;
        if (chatStore.isActiveStreaming) return;
        smooth.flushIfComplete();
    });

    $effect(() => {
        const idx = chatStore.highlightMessageIndex;
        if (idx == null) return;
        let cancelled = false;
        tick().then(() => {
            requestAnimationFrame(() => {
                if (cancelled || !messagesEl) return;
                const el = messagesEl.querySelector(
                    `[data-msg-index="${idx}"]`
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
        if (
            editingMessageId !== null &&
            !chatStore.activeMessages.some((m) => m.id === editingMessageId)
        ) {
            editingMessageId = null;
            editingText = '';
        }
    });

    $effect(() => {
        const policyKey = filePolicyKey;
        if (lastFilePolicyKey === null) {
            lastFilePolicyKey = policyKey;
            return;
        }
        if (lastFilePolicyKey === policyKey) return;
        lastFilePolicyKey = policyKey;
        uploadGeneration++;
        processingAttachments = [];

        const attachments = untrack(() => pendingAttachments);
        if (!attachments.length) return;

        const validation = validateReadyAttachments(
            attachments,
            settingsStore.providerId,
            providersStore.selectedModel
        );
        if (validation.ok) return;

        pendingAttachments = [];
        fileErrors = [
            `File Error: Attached files were removed. ${validation.message}`,
            ...untrack(() => fileErrors),
        ].slice(0, 3);
    });

    function handleMessagesScroll() {
        if (!messagesEl) return;
        isAtTop = messagesEl.scrollTop < 20;
    }

    function handleKeydown(e: KeyboardEvent) {
        const shouldSubmit =
            settingsStore.submitKeystroke === 'ctrl+enter'
                ? e.key === 'Enter' && e.ctrlKey
                : e.key === 'Enter' && !e.shiftKey;
        if (shouldSubmit) {
            e.preventDefault();
            submit();
        }
    }

    function submit() {
        const text = inputText.trim();
        if (
            (!text && !pendingAttachments.length) ||
            chatStore.isActiveStreaming ||
            processingAttachments.length
        ) {
            return;
        }
        if (chatStore.demoMode) {
            appLifecycle.requestExtension();
            return;
        }

        const fileValidation = validateReadyAttachments(
            pendingAttachments,
            settingsStore.providerId,
            providersStore.selectedModel
        );
        if (!fileValidation.ok) {
            fileErrors = [
                `File Error: ${fileValidation.message}`,
                ...untrack(() => fileErrors),
            ].slice(0, 3);
            return;
        }

        stick.scrollToBottom();
        const atts = pendingAttachments;
        pendingAttachments = [];
        chatStore.sendMessage(text, atts.length ? atts : undefined);
        inputText = '';
        if (textareaEl) textareaEl.style.height = '';
    }

    // Stop the current stream. Pass smooth.display so the saved/visible text
    // matches exactly what the user sees — characters queued in the smooth
    // drain are discarded rather than rushed onto the screen.
    function stop() {
        chatStore.stop(smooth.display);
    }

    function handleRetry(index: number) {
        if (chatStore.demoMode) {
            appLifecycle.requestExtension();
            return;
        }
        chatStore.retry(index);
    }

    function openFilePicker() {
        fileInputEl?.click();
    }

    function addFileError(message: string) {
        fileErrors = [
            `File Error: ${message}`,
            ...untrack(() => fileErrors),
        ].slice(0, 3);
    }

    function setProcessingProgress(id: string, progress: number) {
        processingAttachments = processingAttachments.map((attachment) =>
            attachment.id === id ? { ...attachment, progress } : attachment
        );
    }

    function removeProcessingAttachment(id: string) {
        processingAttachments = processingAttachments.filter(
            (attachment) => attachment.id !== id
        );
    }

    function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as ArrayBuffer);
            reader.onerror = () =>
                reject(reader.error ?? new Error('Could not read file.'));
            reader.readAsArrayBuffer(file);
        });
    }

    function bytesToBase64(bytes: Uint8Array): string {
        let binary = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
            binary += String.fromCharCode(
                ...bytes.subarray(i, Math.min(i + CHUNK, bytes.length))
            );
        }
        return btoa(binary);
    }

    async function processFile(
        file: File,
        id: string,
        uploadProviderId: string,
        uploadModel: ModelOption | null,
        generation: number
    ) {
        const isCurrent = () => generation === uploadGeneration;
        const policy = getFilePolicy(uploadProviderId, uploadModel);

        try {
            setProcessingProgress(id, 12);
            const mediaType = resolveFileMediaType(
                file,
                uploadProviderId,
                uploadModel
            );
            if (!mediaType) {
                addFileError(`${file.name} is not supported by this provider.`);
                removeProcessingAttachment(id);
                return;
            }

            setProcessingProgress(id, 24);
            if (!policy.mimeTypes.has(mediaType)) {
                addFileError(
                    `${file.name} (${mediaType}) is not supported by this provider.`
                );
                removeProcessingAttachment(id);
                return;
            }

            setProcessingProgress(id, 38);
            if (file.size > policy.maxFileBytes) {
                addFileError(
                    `${file.name} is ${formatFileSize(file.size)}. Limit: ${formatFileSize(policy.maxFileBytes)}.`
                );
                removeProcessingAttachment(id);
                return;
            }

            setProcessingProgress(id, 50);
            const buffer = await readFileAsArrayBuffer(file);
            if (!isCurrent()) return;

            setProcessingProgress(id, 64);
            const hash = await hashBytes(buffer);
            if (!isCurrent()) return;

            const data = bytesToBase64(new Uint8Array(buffer));
            const encodedSizeBytes = data.length;

            setProcessingProgress(id, 72);
            if (encodedSizeBytes > policy.maxFileBytes) {
                addFileError(
                    `${file.name} is ${formatFileSize(encodedSizeBytes)} after encoding. Limit: ${formatFileSize(policy.maxFileBytes)}.`
                );
                removeProcessingAttachment(id);
                return;
            }

            setProcessingProgress(id, 86);
            const attachment: Attachment = {
                hash,
                name: file.name,
                mediaType,
                sizeBytes: file.size,
                encodedSizeBytes,
                data,
            };
            const nextAttachments = [
                ...untrack(() => pendingAttachments),
                attachment,
            ];
            const validation = validateReadyAttachments(
                nextAttachments,
                uploadProviderId,
                uploadModel
            );
            if (!validation.ok) {
                addFileError(validation.message);
                removeProcessingAttachment(id);
                return;
            }

            setProcessingProgress(id, 100);
            pendingAttachments = nextAttachments;
            removeProcessingAttachment(id);
        } catch (error) {
            if (!isCurrent()) return;
            addFileError(
                error instanceof Error
                    ? `${file.name}: ${error.message}`
                    : `${file.name} could not be processed.`
            );
            removeProcessingAttachment(id);
        }
    }

    function handleFileChange(e: Event) {
        const files = Array.from((e.target as HTMLInputElement).files ?? []);
        if (!fileInputEl) return;
        fileInputEl.value = '';
        if (!files.length) return;

        fileErrors = [];
        const uploadProviderId = settingsStore.providerId;
        const uploadModel = providersStore.selectedModel;
        const uploadPolicy = getFilePolicy(uploadProviderId, uploadModel);
        const generation = uploadGeneration;
        const slots = Math.max(
            0,
            uploadPolicy.maxAttachments -
                pendingAttachments.length -
                processingAttachments.length
        );
        const toAdd = files.slice(0, slots);

        if (toAdd.length < files.length) {
            addFileError(
                `Only ${uploadPolicy.maxAttachments} files can be attached for this provider.`
            );
        }

        for (const file of toAdd) {
            const id = crypto.randomUUID();
            processingAttachments = [
                ...processingAttachments,
                { id, name: file.name, progress: 0 },
            ];
            void processFile(
                file,
                id,
                uploadProviderId,
                uploadModel,
                generation
            );
        }
    }

    function autoResize(e: Event) {
        const ta = e.target as HTMLTextAreaElement;
        const styles = getComputedStyle(ta);
        const verticalBorder =
            parseFloat(styles.borderTopWidth) +
            parseFloat(styles.borderBottomWidth);
        const maxHeight = parseFloat(styles.maxHeight);
        ta.style.height = 'auto';
        ta.style.height = `${Math.min(
            ta.scrollHeight + verticalBorder,
            Number.isFinite(maxHeight) ? maxHeight : Infinity
        )}px`;
    }

    function startEdit(
        id: string,
        content: string,
        bubbleEl?: HTMLElement | null
    ) {
        editingDims = bubbleEl ? { h: bubbleEl.offsetHeight } : null;
        editingMessageId = id;
        editingText = content;
    }

    function saveEdit() {
        if (editingMessageId === null) return;
        const idx = chatStore.activeMessages.findIndex(
            (m) => m.id === editingMessageId
        );
        editingMessageId = null;
        const text = editingText;
        editingText = '';
        if (idx !== -1) chatStore.editMessage(idx, text);
    }

    function cancelEdit() {
        editingMessageId = null;
        editingText = '';
    }

    function setHovered(id: string | null) {
        if (hoverHideTimer !== null) {
            clearTimeout(hoverHideTimer);
            hoverHideTimer = null;
        }
        if (id === null) {
            hoverHideTimer = setTimeout(() => {
                hoveredMessageId = null;
                hoverHideTimer = null;
            }, 120);
        } else {
            hoveredMessageId = id;
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
            {#if settingsStore.systemPrompt.trim()}
                <span
                    class="w-1.5 h-1.5 rounded-full bg-accent-bg shrink-0"
                    aria-label="System prompt is set"
                ></span>
            {/if}
        </button>
        {#if chatStore.demoMode}
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
                    bind:value={settingsStore.systemPrompt}
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
                bind:this={messagesContentEl}
                class="[--narrow-chat-width:744px] mx-auto px-5 py-7 flex flex-col gap-7 min-h-full box-border"
                style="max-width: min(100vw, calc(744px + (100vw - 744px) * {settingsStore.chatWidth /
                    100}));"
            >
                {#if chatStore.chatLoading}
                    <div
                        class="flex flex-col items-center justify-center flex-1 h-full gap-2.5 text-fg"
                    >
                        <p
                            class="text-[0.8125rem] font-normal text-center max-w-70"
                        >
                            Loading...
                        </p>
                    </div>
                {:else if chatStore.activeMessages.length === 0}
                    <div
                        class="flex flex-col items-center justify-center flex-1 h-full gap-2.5 text-fg"
                    >
                        <Icon name="mail-plus" />
                        <p class="text-[0.9375rem] font-medium text-fg m-0">
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
                    {#each chatStore.activeMessages as message, i (message.id)}
                        {@const isLastStreaming =
                            chatStore.isActiveStreaming &&
                            i === chatStore.activeMessages.length - 1}
                        {@const displayContent =
                            i === chatStore.activeMessages.length - 1 &&
                            message.role === 'assistant' &&
                            (chatStore.isActiveStreaming ||
                                smooth.display !== message.content)
                                ? smooth.display
                                : message.content}
                        <MessageItem
                            {message}
                            index={i}
                            {displayContent}
                            isStreaming={chatStore.isActiveStreaming}
                            {isLastStreaming}
                            editing={editingMessageId === message.id}
                            bind:editingText
                            {editingDims}
                            hovered={hoveredMessageId === message.id}
                            thinkingExpanded={expandedThinking.has(message.id)}
                            sourcesExpanded={expandedSources.has(message.id)}
                            onhoverenter={() => setHovered(message.id)}
                            onhoverleave={() => setHovered(null)}
                            onstartedit={(content, bubbleEl) =>
                                startEdit(message.id, content, bubbleEl)}
                            onsaveedit={saveEdit}
                            oncanceledit={cancelEdit}
                            onthinkingtoggle={() => {
                                const next = new Set(expandedThinking);
                                if (next.has(message.id))
                                    next.delete(message.id);
                                else next.add(message.id);
                                expandedThinking = next;
                            }}
                            onsourcestoggle={() => {
                                const next = new Set(expandedSources);
                                if (next.has(message.id))
                                    next.delete(message.id);
                                else next.add(message.id);
                                expandedSources = next;
                            }}
                            onretry={() => handleRetry(i)}
                            ondelete={() => chatStore.deleteMessage(i)}
                        />
                    {/each}
                {/if}
            </div>
        </div>
        {#if !stick.sticky}
            <button
                type="button"
                class="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center justify-center w-7.5 h-7.5 bg-surface-sunken border border-border rounded-full text-fg cursor-pointer z-5 transition-[background-color] duration-150 animate-fade-up hover:bg-border"
                onclick={() => stick.scrollToBottom()}
                aria-label="Scroll to bottom"
            >
                <Icon name="chevron-down" />
            </button>
        {/if}
    </div>

    <!-- App error -->
    {#if errorStore.appError}
        <div
            class="shrink-0 flex items-center gap-3 px-4 py-2 text-sm text-accent-fg border-t border-border bg-canvas"
            role="alert"
        >
            <span class="min-w-0 flex-1 wrap-break-word"
                >{errorStore.appError}</span
            >
            <button
                type="button"
                class="shrink-0 flex items-center justify-center w-6 h-6 p-0 bg-transparent border-0 rounded-md text-accent-fg cursor-pointer opacity-70 transition-[opacity,background-color] duration-150 hover:opacity-100 hover:bg-surface-sunken"
                onclick={() => errorStore.clearAppError()}
                aria-label="Dismiss error"
            >
                <Icon name="close" />
            </button>
        </div>
    {/if}

    <!-- Stream error -->
    {#if chatStore.activeStreamError}
        <div
            class="shrink-0 flex items-center gap-3 px-4 py-2 text-sm text-accent-fg border-t border-border bg-canvas"
            role="alert"
        >
            <span class="min-w-0 flex-1 wrap-break-word"
                >{chatStore.activeStreamError}</span
            >
            <button
                type="button"
                class="shrink-0 flex items-center justify-center w-6 h-6 p-0 bg-transparent border-0 rounded-md text-accent-fg cursor-pointer opacity-70 transition-[opacity,background-color] duration-150 hover:opacity-100 hover:bg-surface-sunken"
                onclick={() => chatStore.clearActiveChatError()}
                aria-label="Dismiss error"
            >
                <Icon name="close" />
            </button>
        </div>
    {/if}

    <!-- Input -->
    <div class="shrink-0 border-t border-border bg-canvas">
        {#if fileErrors.length}
            <div class="flex flex-col gap-1 px-4 pt-2">
                {#each fileErrors as error, i (i)}
                    <div
                        class="flex items-center gap-2 text-xs text-accent-fg"
                        role="alert"
                    >
                        <span class="min-w-0 flex-1 wrap-break-word"
                            >{error}</span
                        >
                        <button
                            type="button"
                            class="flex items-center justify-center w-4 h-4 bg-transparent border-0 p-0 text-accent-fg opacity-60 cursor-pointer shrink-0 transition-opacity duration-150 hover:opacity-100"
                            onclick={() =>
                                (fileErrors = fileErrors.filter(
                                    (_, j) => j !== i
                                ))}
                            aria-label="Dismiss file error"
                        >
                            <Icon name="close" />
                        </button>
                    </div>
                {/each}
            </div>
        {/if}
        {#if pendingAttachments.length || processingAttachments.length}
            <div class="flex items-start justify-between gap-3 px-4 pt-2">
                <div class="flex flex-wrap gap-1 min-w-0">
                    {#each processingAttachments as att (att.id)}
                        <div
                            class="relative overflow-hidden inline-flex items-center gap-1.5 pl-2.5 pr-2 py-1.25 bg-surface-sunken border border-border rounded-lg text-xs text-fg max-w-60"
                        >
                            <span
                                class="absolute top-0 left-0 h-0.5 bg-accent-3-bg transition-[width] duration-150"
                                style="width: {att.progress}%"
                            ></span>
                            <Icon name="spinner" />
                            <span
                                class="overflow-hidden text-ellipsis whitespace-nowrap max-w-45"
                                >{att.name}</span
                            >
                        </div>
                    {/each}
                    {#each pendingAttachments as att, i (att.hash)}
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
                                    (pendingAttachments =
                                        pendingAttachments.filter(
                                            (_, j) => j !== i
                                        ))}
                                aria-label="Remove attachment"
                            >
                                <Icon name="close" />
                            </button>
                        </div>
                    {/each}
                </div>
                <div
                    class="shrink-0 pt-1 text-[0.6875rem] leading-none text-fg-muted tabular-nums"
                >
                    {formatFileSize(attachmentTotalBytes)} / {formatFileSize(
                        filePolicy.maxRequestBytes
                    )}
                </div>
            </div>
        {/if}
        <div class="flex items-end gap-2 px-4 py-3 bg-canvas shrink-0">
            <input
                type="file"
                accept={fileAccept}
                multiple
                class="hidden"
                bind:this={fileInputEl}
                onchange={handleFileChange}
            />
            <button
                type="button"
                class="{sendStyleBase} bg-surface-sunken text-fg border! border-border! enabled:hover:bg-border disabled:opacity-[0.35] disabled:cursor-not-allowed"
                onclick={openFilePicker}
                disabled={chatStore.isActiveStreaming ||
                    !canAttachFiles ||
                    pendingAttachments.length + processingAttachments.length >=
                        filePolicy.maxAttachments}
                aria-label="Attach file"
            >
                <Icon name="plus" />
            </button>
            <textarea
                class="flex-1 min-h-[calc(22px+0.875rem*1.5)] max-h-50 px-3.5 py-2.5 bg-canvas border border-border rounded-lg text-fg font-sans text-sm leading-normal resize-none box-border outline-none transition-[border-color] duration-150 focus:border-accent-fg placeholder:text-fg-muted [&::-webkit-scrollbar]:hidden"
                placeholder="Write a message"
                rows="1"
                bind:value={inputText}
                bind:this={textareaEl}
                onkeydown={handleKeydown}
                oninput={autoResize}
            ></textarea>
            {#if chatStore.isActiveStreaming && chatStore.isActiveLocalStreaming}
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
                    disabled={chatStore.isActiveStreaming ||
                        processingAttachments.length > 0 ||
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
