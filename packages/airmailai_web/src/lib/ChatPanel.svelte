<script lang="ts">
    import type {
        DraftAttachmentMeta,
        FileAvailability,
    } from '@airmailai/shared';
    import { tick, untrack } from 'svelte';
    import { SvelteSet } from 'svelte/reactivity';
    import { appLifecycle } from './appLifecycle.svelte';
    import { chatStore } from './chatStore.svelte';
    import { errorStore, reportAppError } from './errorStore.svelte';
    import { getFileStatuses } from './extension';
    import {
        type FilePolicyOptions,
        formatFileSize,
        getAcceptForProvider,
        getFilePolicy,
        resolveFileMediaType,
        validateFilename,
        validateReadyAttachments,
    } from './files';
    import Icon from './Icon.svelte';
    import MessageItem from './MessageItem.svelte';
    import type { ModelOption } from './models';
    import { providersStore } from './providersStore.svelte';
    import { settingsStore } from './settingsStore.svelte';
    import { createChatScroll } from './chatScroll.svelte';
    import { createSmoothText } from './smoothText.svelte';
    import { messageText } from './types';
    import { versionCheck } from './versionCheck.svelte';

    let systemExpanded = $state(false);
    const expandedThinking = new SvelteSet<string>();
    const expandedSources = new SvelteSet<string>();
    const expandedCode = new SvelteSet<string>();
    const expandedSuggestions = new SvelteSet<string>();
    let inputText = $state('');
    let messagesEl = $state<HTMLElement | null>(null);
    let messagesContentEl = $state<HTMLElement | null>(null);
    let textareaEl = $state<HTMLTextAreaElement | null>(null);
    let fileInputEl = $state<HTMLInputElement | null>(null);
    let dragDepth = $state(0);
    let isAtTop = $state(true);
    let pendingAttachments = $derived(chatStore.activeDraftAttachments);
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
    let editingMessage = $derived(
        editingMessageId === null
            ? null
            : (chatStore.activeMessages.find(
                  (m) => m.id === editingMessageId
              ) ?? null)
    );

    let fileStatuses = $state<Record<string, FileAvailability>>({});
    const activeFileHashesKey = $derived.by(() => {
        const hashes = new Set<string>();
        for (const m of chatStore.activeMessages) {
            for (const p of m.parts) {
                if (p.type === 'file') hashes.add(p.hash);
            }
        }
        return [...hashes].sort().join(',');
    });

    $effect(() => {
        chatStore.fileStatusVersion;
        const key = activeFileHashesKey;
        const provider = settingsStore.providerId;
        settingsStore.enableProviderFileStorage;
        if (chatStore.demoMode || !key) {
            fileStatuses = {};
            return;
        }
        let cancelled = false;
        getFileStatuses(key.split(','), provider)
            .then((statuses) => {
                if (!cancelled) fileStatuses = statuses;
            })
            .catch((err) => {
                reportAppError(
                    'file status check failed',
                    "Couldn't check file availability",
                    err
                );
            });
        return () => {
            cancelled = true;
        };
    });

    let uploadGeneration = 0;
    let fileProcessingQueue = Promise.resolve();
    let filePolicyOpts = $derived({
        openRouterPdfEngine: settingsStore.openRouterPdfEngine,
    });
    let filePolicy = $derived(
        getFilePolicy(
            settingsStore.providerId,
            providersStore.selectedModel,
            filePolicyOpts
        )
    );
    let providerName = $derived(
        providersStore.providers.find((p) => p.id === settingsStore.providerId)
            ?.name ?? settingsStore.providerId
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
            providersStore.selectedModel,
            filePolicyOpts
        )
    );
    let canAttachFiles = $derived(filePolicy.mimeTypes.size > 0);
    let attachmentTotalBytes = $derived(
        pendingAttachments.reduce(
            (total, attachment) => total + attachment.sizeBytes,
            0
        )
    );

    const chatScroll = createChatScroll();

    const IMMEDIATE_RENDER_TAIL = 12;

    let lastUserMessageIndex = $derived.by(() => {
        const msgs = chatStore.activeMessages;
        for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === 'user') return i;
        }
        return -1;
    });
    let lastUserMessageEl: HTMLElement | null = null;

    function findLastUserMessageEl(): HTMLElement | null {
        if (!messagesEl) return null;
        const index = lastUserMessageIndex;
        if (index < 0) return null;
        if (
            lastUserMessageEl?.isConnected &&
            lastUserMessageEl.dataset.msgIndex === String(index) &&
            messagesEl.contains(lastUserMessageEl)
        ) {
            return lastUserMessageEl;
        }
        lastUserMessageEl = messagesEl.querySelector<HTMLElement>(
            `[data-msg-index="${index}"]`
        );
        return lastUserMessageEl;
    }

    const smooth = createSmoothText({
        mode: () => settingsStore.smoothTextMode,
        streaming: () => untrack(() => chatStore.isActiveStreaming),
        onReset: () => {
            if (untrack(() => settingsStore.autoscrollMode) === 'pin-bottom')
                chatScroll.markAtBottom();
        },
    });

    $effect(() => {
        return () => smooth.cancel();
    });

    $effect(() => {
        if (!messagesEl || !messagesContentEl) return;
        return chatScroll.attach(
            messagesEl,
            messagesContentEl,
            () => settingsStore.autoscrollMode,
            findLastUserMessageEl
        );
    });

    $effect(() => {
        settingsStore.autoscrollMode;
        chatScroll.onModeChange();
    });

    let scrolledChatId: string | null | undefined = undefined;

    $effect(() => {
        const chatId = chatStore.activeChatId;
        if (chatStore.chatLoading) return;
        if (chatId === scrolledChatId) return;
        scrolledChatId = chatId;
        untrack(() =>
            chatScroll.onChatChange(chatStore.highlightMessageIndex == null)
        );
    });

    $effect.pre(() => {
        const streaming = chatStore.activeStreamingText;
        if (streaming !== null) {
            smooth.setRaw(streaming);
        } else {
            const last =
                chatStore.activeMessages[chatStore.activeMessages.length - 1];
            smooth.setRaw(last ? messageText(last) : '');
        }
    });

    $effect(() => {
        const idx = chatStore.highlightMessageIndex;
        if (idx == null) return;
        if (chatStore.chatLoading || chatStore.activeMessages.length <= idx)
            return;
        let cancelled = false;
        tick().then(() => {
            requestAnimationFrame(() => {
                if (cancelled || !messagesEl) return;
                const el = messagesEl.querySelector(
                    `[data-msg-index="${idx}"]`
                ) as HTMLElement | null;
                if (!el) return;
                chatStore.highlightMessageIndex = null;
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
            providersStore.selectedModel,
            filePolicyOpts
        );
        if (validation.ok) return;

        void chatStore.clearActiveDraftAttachments();
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

    async function submit() {
        await appLifecycle.ready;
        const text = inputText.trim();
        if (
            (!text && !pendingAttachments.length) ||
            chatStore.isActiveStreaming ||
            chatStore.chatLoading ||
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
            providersStore.selectedModel,
            filePolicyOpts
        );
        if (!fileValidation.ok) {
            fileErrors = [
                `File Error: ${fileValidation.message}`,
                ...untrack(() => fileErrors),
            ].slice(0, 3);
            return;
        }

        const submittedInput = inputText;
        inputText = '';
        if (textareaEl) textareaEl.style.height = '';
        const started = await chatStore.sendMessage(text);
        if (!started) {
            inputText = inputText
                ? `${submittedInput}\n${inputText}`
                : submittedInput;
            await tick();
            if (textareaEl) resizeTextarea(textareaEl);
            return;
        }
        scrolledChatId = chatStore.activeChatId;
        chatScroll.onSubmit();
    }

    function stop() {
        const visibleChars = smooth.display.length;
        smooth.snapToDisplay();
        chatStore.stop(visibleChars);
    }

    function handleRetry(index: number) {
        if (chatStore.demoMode) {
            appLifecycle.requestExtension();
            return;
        }
        chatStore.retry(index);
    }

    function openFilePicker() {
        if (chatStore.demoMode) {
            appLifecycle.requestExtension();
            return;
        }
        if (!settingsStore.enableFileUploads) return;
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

    async function processFile(
        file: File,
        id: string,
        uploadProviderId: string,
        uploadModel: ModelOption | null,
        uploadOpts: FilePolicyOptions,
        generation: number
    ) {
        const isCurrent = () => generation === uploadGeneration;
        const policy = getFilePolicy(uploadProviderId, uploadModel, uploadOpts);

        try {
            setProcessingProgress(id, 12);
            const nameCheck = validateFilename(file.name);
            if (!nameCheck.ok) {
                addFileError(nameCheck.message);
                removeProcessingAttachment(id);
                return;
            }

            const mediaType = resolveFileMediaType(
                file,
                uploadProviderId,
                uploadModel,
                uploadOpts
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

            setProcessingProgress(id, 48);
            const draftAtt: DraftAttachmentMeta = {
                name: file.name,
                mediaType,
                sizeBytes: file.size,
                encodedSizeBytes: Math.ceil(file.size / 3) * 4,
            };
            const nextAttachments = [
                ...untrack(() => pendingAttachments),
                draftAtt,
            ];
            const validation = validateReadyAttachments(
                nextAttachments,
                uploadProviderId,
                uploadModel,
                uploadOpts
            );
            if (!validation.ok) {
                addFileError(validation.message);
                removeProcessingAttachment(id);
                return;
            }

            const staged = await chatStore.addDraftAttachment(
                draftAtt,
                file,
                (progress) => setProcessingProgress(id, 50 + progress * 50)
            );
            if (!isCurrent()) {
                if (staged) {
                    await chatStore.removeDraftAttachment(
                        staged.attachment.hash,
                        staged.chatId
                    );
                }
                return;
            }
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
        addFiles(files);
    }

    async function addFiles(files: File[]) {
        if (!files.length) return;
        await appLifecycle.ready;

        fileErrors = [];
        const uploadProviderId = settingsStore.providerId;
        const uploadModel = providersStore.selectedModel;
        const uploadOpts = filePolicyOpts;
        const uploadPolicy = getFilePolicy(
            uploadProviderId,
            uploadModel,
            uploadOpts
        );
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

        const queued = toAdd.map((file) => ({
            file,
            id: crypto.randomUUID(),
        }));
        processingAttachments = [
            ...processingAttachments,
            ...queued.map(({ file, id }) => ({
                id,
                name: file.name,
                progress: 0,
            })),
        ];
        fileProcessingQueue = fileProcessingQueue.then(async () => {
            for (const { file, id } of queued) {
                await processFile(
                    file,
                    id,
                    uploadProviderId,
                    uploadModel,
                    uploadOpts,
                    generation
                );
            }
        });
    }

    let canAcceptFileDrops = $derived(
        settingsStore.enableFileUploads &&
            !chatStore.demoMode &&
            canAttachFiles &&
            !chatStore.isActiveStreaming
    );

    function dragHasFiles(e: DragEvent): boolean {
        return !!e.dataTransfer?.types.includes('Files');
    }

    function handleDragEnter(e: DragEvent) {
        if (!canAcceptFileDrops || !dragHasFiles(e)) return;
        e.preventDefault();
        dragDepth++;
    }

    function handleDragOver(e: DragEvent) {
        if (!canAcceptFileDrops || !dragHasFiles(e)) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    }

    function handleDragLeave(e: DragEvent) {
        if (!canAcceptFileDrops || !dragHasFiles(e)) return;
        dragDepth = Math.max(0, dragDepth - 1);
    }

    function handleDrop(e: DragEvent) {
        dragDepth = 0;
        if (!canAcceptFileDrops || !dragHasFiles(e)) return;
        e.preventDefault();
        addFiles(Array.from(e.dataTransfer?.files ?? []));
    }

    function handlePaste(e: ClipboardEvent) {
        if (!canAcceptFileDrops) return;
        if (document.querySelector('[role="dialog"]')) return;
        const files = Array.from(e.clipboardData?.files ?? []);
        if (!files.length) return;
        e.preventDefault();
        addFiles(files);
    }

    function resizeTextarea(ta: HTMLTextAreaElement) {
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

    function autoResize(e: Event) {
        resizeTextarea(e.target as HTMLTextAreaElement);
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

    function saveEditAndResend() {
        if (editingMessageId === null) return;
        const idx = chatStore.activeMessages.findIndex(
            (m) => m.id === editingMessageId
        );
        editingMessageId = null;
        const text = editingText;
        editingText = '';
        if (idx === -1) return;
        chatStore.editMessage(idx, text);
        if (chatStore.demoMode) {
            appLifecycle.requestExtension();
            return;
        }
        chatStore.retry(idx);
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

<svelte:window onpaste={handlePaste} />

<div
    role="region"
    aria-label="Chat"
    class="relative flex-1 flex flex-col overflow-hidden bg-canvas min-w-0"
    ondragenter={handleDragEnter}
    ondragover={handleDragOver}
    ondragleave={handleDragLeave}
    ondrop={handleDrop}
>
    {#if dragDepth > 0}
        <div
            class="absolute inset-2 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-accent-fg bg-canvas/85 pointer-events-none"
            aria-hidden="true"
        >
            <span class="text-sm font-medium text-accent-fg"
                >Drop files to attach</span
            >
        </div>
    {/if}
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
                    bind:value={settingsStore.systemPrompt}></textarea>
            </div>
        {/if}
    </div>

    <div class="flex-1 relative min-h-0">
        <div
            class="absolute top-0 left-0 right-0 h-lh text-sm leading-[1.65] bg-linear-to-b from-canvas to-transparent pointer-events-none z-2 transition-opacity duration-200 {!isAtTop
                ? 'opacity-100'
                : 'opacity-0'}"
            aria-hidden="true"
        ></div>
        <div
            class="thin-scrollbar h-full overflow-y-auto"
            bind:this={messagesEl}
            onscroll={handleMessagesScroll}
        >
            <div
                bind:this={messagesContentEl}
                class="[--narrow-chat-width:744px] mx-auto px-5 py-7 flex flex-col min-h-full box-border"
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
                        {@const streamingText =
                            isLastStreaming && message.role === 'assistant'
                                ? chatStore.activeStreamingText
                                : null}
                        {@const messageContent =
                            streamingText !== null
                                ? streamingText
                                : messageText(message)}
                        {@const displayContent =
                            i === chatStore.activeMessages.length - 1 &&
                            message.role === 'assistant' &&
                            smooth.target === messageContent
                                ? smooth.display
                                : messageContent}
                        <MessageItem
                            {message}
                            index={i}
                            {messageContent}
                            {displayContent}
                            {fileStatuses}
                            maxFileBytes={filePolicy.maxFileBytes}
                            {providerName}
                            isStreaming={chatStore.isActiveStreaming}
                            isLastStreaming={isLastStreaming ||
                                displayContent !== messageContent}
                            deferRender={i <
                                chatStore.activeMessages.length -
                                    IMMEDIATE_RENDER_TAIL &&
                                chatStore.highlightMessageIndex == null}
                            editing={editingMessage?.id === message.id}
                            bind:editingText
                            {editingDims}
                            hovered={hoveredMessageId === message.id}
                            thinkingExpanded={expandedThinking.has(message.id)}
                            sourcesExpanded={expandedSources.has(message.id)}
                            codeExpanded={expandedCode.has(message.id)}
                            suggestionsExpanded={expandedSuggestions.has(
                                message.id
                            )}
                            onhoverenter={() => setHovered(message.id)}
                            onhoverleave={() => setHovered(null)}
                            onstartedit={(content, bubbleEl) =>
                                startEdit(message.id, content, bubbleEl)}
                            onsaveedit={saveEdit}
                            onsaveresend={saveEditAndResend}
                            oncanceledit={cancelEdit}
                            onthinkingtoggle={() => {
                                if (expandedThinking.has(message.id))
                                    expandedThinking.delete(message.id);
                                else expandedThinking.add(message.id);
                            }}
                            onsourcestoggle={() => {
                                if (expandedSources.has(message.id))
                                    expandedSources.delete(message.id);
                                else expandedSources.add(message.id);
                            }}
                            oncodetoggle={() => {
                                if (expandedCode.has(message.id))
                                    expandedCode.delete(message.id);
                                else expandedCode.add(message.id);
                            }}
                            onsuggestionstoggle={() => {
                                if (expandedSuggestions.has(message.id))
                                    expandedSuggestions.delete(message.id);
                                else expandedSuggestions.add(message.id);
                            }}
                            onretry={() => handleRetry(i)}
                            ondelete={() => chatStore.deleteMessage(i)}
                            ondeletefile={(key) =>
                                chatStore.deleteMessageFile(i, key)}
                        />
                    {/each}
                    <div
                        aria-hidden="true"
                        style:height="{chatScroll.spacerHeight}px"
                    ></div>
                {/if}
            </div>
        </div>
        {#if !chatScroll.atBottom}
            <button
                type="button"
                class="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center justify-center w-7.5 h-7.5 bg-surface-sunken border border-border rounded-full text-fg cursor-pointer z-5 transition-[background-color] duration-150 animate-fade-up hover:bg-border"
                onclick={() => chatScroll.scrollToBottom()}
                aria-label="Scroll to bottom"
            >
                <Icon name="chevron-down" />
            </button>
        {/if}
    </div>

    {#if versionCheck.notice}
        <div
            class="shrink-0 flex items-center gap-3 px-4 py-2 text-sm text-fg border-t border-border bg-canvas"
            role="status"
        >
            <span class="min-w-0 flex-1 wrap-break-word"
                >{versionCheck.notice.message}</span
            >
            {#if versionCheck.notice.refresh}
                <button
                    type="button"
                    class="shrink-0 px-2.5 py-1 text-xs bg-surface-sunken border border-border rounded-md text-fg cursor-pointer transition-[background-color] duration-150 hover:bg-border"
                    onclick={() => location.reload()}
                >
                    Refresh
                </button>
            {/if}
            <button
                type="button"
                class="shrink-0 flex items-center justify-center w-6 h-6 p-0 bg-transparent border-0 rounded-md text-fg cursor-pointer opacity-70 transition-[opacity,background-color] duration-150 hover:opacity-100 hover:bg-surface-sunken"
                onclick={() => versionCheck.dismiss()}
                aria-label="Dismiss update notice"
            >
                <Icon name="close" />
            </button>
        </div>
    {/if}

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
                    {#each processingAttachments.toReversed() as att (att.id)}
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
                    {#each pendingAttachments.toReversed() as att (att.hash)}
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
                                    chatStore.removeDraftAttachment(att.hash)}
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
                class={[
                    sendStyleBase,
                    'bg-surface-sunken text-fg border! border-border! disabled:opacity-[0.35] disabled:cursor-not-allowed',
                    settingsStore.enableFileUploads
                        ? 'enabled:hover:bg-border'
                        : 'opacity-[0.35] cursor-not-allowed',
                ]}
                onclick={openFilePicker}
                disabled={chatStore.isActiveStreaming ||
                    !canAttachFiles ||
                    pendingAttachments.length + processingAttachments.length >=
                        filePolicy.maxAttachments}
                aria-disabled={!settingsStore.enableFileUploads}
                title={settingsStore.enableFileUploads
                    ? undefined
                    : 'Enable file upload in settings'}
                aria-label="Attach file"
            >
                <Icon name="plus" />
            </button>
            <textarea
                class="flex-1 min-h-[calc(22px+0.875rem*1.5)] max-h-50 px-3.5 py-2.5 bg-canvas border border-border rounded-lg text-fg font-sans text-sm leading-normal resize-none box-border outline-none transition-[border-color] duration-150 focus:border-accent-fg placeholder:text-fg-muted [&::-webkit-scrollbar]:hidden"
                placeholder="Write a message"
                aria-label="Message"
                rows="1"
                bind:value={inputText}
                bind:this={textareaEl}
                onkeydown={handleKeydown}
                oninput={autoResize}></textarea>
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
                        chatStore.chatLoading ||
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
