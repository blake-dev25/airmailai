import type {
    ChatMeta,
    AirmailAIChunk,
    AirmailAIMessage,
    DraftAttachment,
    DraftAttachmentMeta,
    MessageAssemblerState,
    StoredChat,
    StoredMessage,
    StreamErrorSource,
} from '@airmailai/shared';
import {
    createMessageAssembler,
    truncateMessageTextParts,
} from '@airmailai/shared';
import { SvelteSet } from 'svelte/reactivity';
import {
    backupFilename,
    buildBackupExport,
    buildAirmailAIJsonExport,
    buildJsonExport,
    buildMarkdownExport,
    buildSillyTavernExport,
    cleanInline,
    exportFilename,
    MAX_IMPORT_FILE_BYTES,
    parseChatTransferFile,
    sillyTavernFilename,
    type ChatExportFormat,
    type ChatTransferParseResult,
    type ImportedChat,
    type TransferChatInfo,
} from './chatTransfer';
import { buildDemoChats } from './demo';
import { reportAppError } from './errorStore.svelte';
import {
    clearDraftAttachments,
    clearFileBlobCache,
    deleteChat,
    deleteMessage,
    importChats,
    loadChat,
    loadChatMetas,
    loadChatsByIds,
    prepareRetry,
    prepareTurn,
    putMessage,
    removeDraftAttachment as reqRemoveDraftAttachment,
    saveMeta,
    sendToExtension,
    stageDraftAttachment,
    type StreamHandle,
    tabId,
} from './extension';
import { triggerBlobDownload } from './files';
import { providersStore } from './providersStore.svelte';
import { settingsStore } from './settingsStore.svelte';
import { createStreamBatcher, type StreamBatcher } from './streamBatcher';
import { versionCheck } from './versionCheck.svelte';
import {
    messageText,
    type Chat,
    type Message,
    type SearchResult,
} from './types';

import { log } from './log';
const IMPORT_BATCH_CHARS = 4 * 1024 * 1024;

function formatStreamError(message: string, source: StreamErrorSource): string {
    return `${source === 'extension' ? 'Ext' : 'API'} Error: ${message}`;
}

const AUTO_TITLE_CHARS = 40;

function chatTitleFor(content: string, attachments: DraftAttachment[]): string {
    return (
        cleanInline(content.replace(/\s+/g, ' '), AUTO_TITLE_CHARS) ||
        cleanInline(attachments[0]?.name, AUTO_TITLE_CHARS) ||
        'Empty chat'
    );
}

function buildUserMessage(
    id: string,
    createdAt: number,
    content: string,
    attachments?: DraftAttachment[]
): AirmailAIMessage {
    const parts: AirmailAIMessage['parts'] = [];
    if (content) {
        parts.push({ type: 'text', text: content, state: 'done' });
    }
    for (const att of attachments ?? []) {
        parts.push({
            type: 'file',
            filename: att.name,
            mediaType: att.mediaType,
            sizeBytes: att.sizeBytes,
            hash: att.hash,
        });
    }
    return {
        id,
        role: 'user',
        parts,
        metadata: { createdAt },
    };
}

function buildAssistantPlaceholder(
    id: string,
    createdAt: number
): AirmailAIMessage {
    return {
        id,
        role: 'assistant',
        parts: [],
        metadata: { createdAt },
    };
}

function toStoredMessage(chatId: string, msg: AirmailAIMessage): StoredMessage {
    return { chatId, message: msg };
}

function chatSortKey(c: { createdAt: number; lastMessageAt?: number }): number {
    return settingsStore.chatSortOrder === 'created'
        ? c.createdAt
        : (c.lastMessageAt ?? c.createdAt);
}

function chatToMeta(chat: Chat): ChatMeta {
    return {
        id: chat.id,
        title: chat.title,
        createdAt: chat.createdAt,
        ...(chat.lastMessageAt !== undefined
            ? { lastMessageAt: chat.lastMessageAt }
            : {}),
        providerId: chat.providerId,
        modelId: chat.modelId,
        temperature: chat.temperature,
        maxTokens: chat.maxTokens,
        thinkingLevel: chat.thinkingLevel,
        adaptiveThinking: chat.adaptiveThinking,
        webSearch: chat.webSearch,
        webFetch: chat.webFetch,
        codeExecution: chat.codeExecution,
        systemPrompt: chat.systemPrompt,
    };
}

function chatFromMeta(meta: ChatMeta): Chat {
    return { ...meta, messages: [], messagesLoaded: false };
}

function snapshotChat(chat: Chat): Chat {
    return {
        ...chat,
        messages: [...chat.messages],
        draftAttachments: [...(chat.draftAttachments ?? [])],
    };
}

function storedToMessages(stored: StoredMessage[]): Message[] {
    return stored.map((s) => s.message);
}

interface RemoteStreamPipeline {
    assembler: MessageAssemblerState;
    batcher: StreamBatcher;
    placeholderId: string;
    chat: Chat;
}

class ChatStore {
    chats = $state<Chat[]>([]);
    activeChatId = $state<string | null>(null);
    streamingChatIds = new SvelteSet<string>();
    remoteStreamingChatIds = new SvelteSet<string>();
    chatErrors = $state<Record<string, string>>({});
    searchResults = $state<SearchResult[] | null>(null);
    searchQuery = $state('');
    highlightMessageIndex = $state<number | null>(null);
    chatLoading = $state(false);
    demoMode = $state(false);
    fileStatusVersion = $state(0);
    searchingAll = $state(false);
    allChatsSearched = $state(false);
    private searchCache: Map<string, Message[]> | null = null;
    private streamHandles = new Map<string, StreamHandle>();
    private streamBatchers = new Map<string, StreamBatcher>();
    private remotePipelines = new Map<string, RemoteStreamPipeline>();
    unsearchedChatCount = $derived(
        this.chats.filter((c) => !c.messagesLoaded).length
    );
    sortedChats = $derived(
        [...this.chats].sort((a, b) => chatSortKey(b) - chatSortKey(a))
    );
    isActiveLocalStreaming = $derived(
        this.streamingChatIds.has(this.activeChatId ?? '')
    );
    isActiveRemoteStreaming = $derived(
        this.remoteStreamingChatIds.has(this.activeChatId ?? '')
    );
    isActiveStreaming = $derived(
        this.isActiveLocalStreaming || this.isActiveRemoteStreaming
    );
    allStreamingChatIds = $derived(
        new Set([...this.streamingChatIds, ...this.remoteStreamingChatIds])
    );
    activeStreamError = $derived(
        this.chatErrors[this.activeChatId ?? ''] ?? null
    );
    activeChat = $derived(
        this.chats.find((c) => c.id === this.activeChatId) ?? null
    );
    activeMessages = $derived(this.activeChat?.messages ?? []);
    activeDraftAttachments = $derived(this.activeChat?.draftAttachments ?? []);
    activeStreamingText = $derived(this.activeChat?.streamingText ?? null);
    activeTokens = $derived.by(() => {
        const msgs = this.activeChat?.messages ?? [];
        for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (m.role === 'assistant' && m.metadata?.tokens) {
                return m.metadata.tokens;
            }
        }
        return null;
    });

    private findChat(id: string): Chat | undefined {
        return this.chats.find((c) => c.id === id);
    }

    async loadChats(): Promise<void> {
        let metas: ChatMeta[];
        try {
            metas = await loadChatMetas();
        } catch (err) {
            reportAppError(
                'loadChats: metas failed',
                "Couldn't load chat list",
                err
            );
            return;
        }
        this.chats = metas.map(chatFromMeta);
        log.info('chat metas loaded', `${metas.length} chats`);
    }

    private applyLoadedMessages(stored: StoredChat): void {
        const chat = this.findChat(stored.id);
        if (!chat || chat.messagesLoaded) return;
        if (this.allStreamingChatIds.has(chat.id)) return;
        chat.messages = storedToMessages(stored.messages);
        chat.revision = stored.revision;
        chat.messagesLoaded = true;
    }

    loadDemo(): void {
        const demoChats = buildDemoChats({
            providerId: settingsStore.providerId,
            modelId: settingsStore.modelId,
            temperature: settingsStore.temperature,
            maxTokens: settingsStore.maxTokens,
            thinkingLevel: settingsStore.thinkingLevel,
            adaptiveThinking: settingsStore.adaptiveThinking,
            webSearch: settingsStore.webSearch,
            webFetch: settingsStore.webFetch,
            codeExecution: settingsStore.codeExecution,
        });
        this.chats = demoChats;
        this.activeChatId = demoChats[0].id;
        this.demoMode = true;
        log.info('entered demo mode');
    }

    private matchChat(
        id: string,
        title: string,
        messages: Message[],
        q: string
    ): SearchResult | null {
        for (let i = 0; i < messages.length; i++) {
            const content = messageText(messages[i]);
            const idx = content.toLowerCase().indexOf(q);
            if (idx !== -1) {
                const start = Math.max(0, idx - 40);
                const end = Math.min(content.length, idx + q.length + 60);
                const snippet =
                    (start > 0 ? '...' : '') +
                    content.slice(start, end) +
                    (end < content.length ? '...' : '');
                return { id, title, snippet, matchIndex: i };
            }
        }
        if (title.toLowerCase().includes(q)) {
            const firstMsg = messages.find((m) => messageText(m).length > 0);
            const firstText = firstMsg ? messageText(firstMsg) : '';
            const snippet = firstText
                ? firstText.slice(0, 100) +
                  (firstText.length > 100 ? '...' : '')
                : '';
            return { id, title, snippet, matchIndex: null };
        }
        return null;
    }

    search(query: string): void {
        this.searchQuery = query;
        this.highlightMessageIndex = null;
        const q = query.toLowerCase();
        const results: SearchResult[] = [];
        for (const chat of this.chats) {
            const messages = chat.messagesLoaded
                ? chat.messages
                : this.searchCache?.get(chat.id);
            if (!messages) continue;
            const result = this.matchChat(chat.id, chat.title, messages, q);
            if (result) results.push(result);
        }
        this.searchResults = results;
    }

    clearSearch(): void {
        this.searchResults = null;
        this.searchQuery = '';
        this.highlightMessageIndex = null;
        this.searchCache = null;
        this.allChatsSearched = false;
    }

    async searchAllChats(): Promise<void> {
        if (
            this.searchingAll ||
            this.allChatsSearched ||
            this.unsearchedChatCount === 0
        )
            return;
        this.searchingAll = true;
        try {
            const unloadedIds = this.chats
                .filter((c) => !c.messagesLoaded)
                .map((c) => c.id);
            const fullChats = await loadChatsByIds(unloadedIds);
            const cache = new Map<string, Message[]>();
            for (const stored of fullChats) {
                cache.set(stored.id, storedToMessages(stored.messages));
            }
            this.searchCache = cache;
            this.allChatsSearched = true;
            log.info('search cache built', `${fullChats.length} chats`);
            if (this.searchQuery) this.search(this.searchQuery);
        } catch (err) {
            reportAppError(
                'searchAllChats failed',
                "Couldn't load all chats for search",
                err
            );
        } finally {
            this.searchingAll = false;
        }
    }

    resetLocal(): void {
        log.info('resetting local chat state');
        for (const handle of this.streamHandles.values()) handle.abort();
        for (const batcher of this.streamBatchers.values()) batcher.discard();
        this.streamHandles.clear();
        this.streamBatchers.clear();
        for (const pipeline of this.remotePipelines.values()) {
            pipeline.batcher.discard();
        }
        this.remotePipelines.clear();
        this.chats = [];
        this.activeChatId = null;
        this.streamingChatIds.clear();
        this.remoteStreamingChatIds.clear();
        this.chatErrors = {};
        this.clearSearch();
        clearFileBlobCache();
        settingsStore.systemPrompt = '';
        settingsStore.applyToolDefaults(providersStore.selectedModel);
    }

    clearChatError(id: string): void {
        if (!this.chatErrors[id]) return;
        const { [id]: _, ...rest } = this.chatErrors;
        this.chatErrors = rest;
    }

    clearActiveChatError(): void {
        if (!this.activeChatId) return;
        this.clearChatError(this.activeChatId);
    }

    newChat(): void {
        const id = crypto.randomUUID();
        const now = Date.now();
        log.info('new chat', id);
        settingsStore.applyToolDefaults(providersStore.selectedModel);
        this.chats.unshift({
            id,
            title: 'New Chat',
            messages: [],
            messagesLoaded: true,
            createdAt: now,
            ...settingsStore.snapshotChatConfig(),
        });
        this.activeChatId = id;
    }

    async activate(id: string, matchIndex?: number | null): Promise<void> {
        this.highlightMessageIndex = matchIndex ?? null;
        log.info('select chat', id);
        this.activeChatId = id;
        const chat = this.findChat(id);
        if (!chat) return;
        settingsStore.applyChatConfig(chat);
        if (chat.messagesLoaded || this.demoMode) return;
        const full = await this.loadChatReported(id);
        if (full) this.applyLoadedMessages(full);
    }

    private async loadChatReported(id: string): Promise<StoredChat | null> {
        this.chatLoading = true;
        try {
            return await loadChat(id);
        } catch (err) {
            reportAppError(
                `activate: loadChat failed (id=${id})`,
                "Couldn't load chat",
                err
            );
            return null;
        } finally {
            this.chatLoading = false;
        }
    }

    private abortLocalStream(id: string): void {
        this.streamHandles.get(id)?.abort();
        this.streamHandles.delete(id);
        this.streamBatchers.get(id)?.discard();
        this.streamBatchers.delete(id);
        this.streamingChatIds.delete(id);
    }

    private removeLocal(id: string): void {
        this.abortLocalStream(id);
        const chatIdx = this.chats.findIndex((c) => c.id === id);
        if (chatIdx >= 0) this.chats.splice(chatIdx, 1);
        if (this.activeChatId === id) {
            this.activeChatId = null;
            settingsStore.systemPrompt = '';
            settingsStore.applyToolDefaults(providersStore.selectedModel);
        }
        this.remoteStreamingChatIds.delete(id);
        this.closeRemotePipeline(id);
        this.clearChatError(id);
    }

    remove(id: string): void {
        log.info('remove chat', id);
        const removedTitle = this.findChat(id)?.title;
        this.removeLocal(id);
        if (!this.demoMode)
            deleteChat(id).catch((err) => {
                reportAppError(
                    `delete chat failed (id=${id})`,
                    `Couldn't delete${removedTitle ? ` "${removedTitle}"` : ' chat'}`,
                    err
                );
            });
    }

    applyRemoteChatDeleted(chatId: string): void {
        log.info('remote chat deleted', chatId);
        this.removeLocal(chatId);
    }

    applyRemoteMetaChanged(meta: ChatMeta): void {
        const chat = this.findChat(meta.id);
        if (chat) {
            const revision = chat.revision;
            Object.assign(chat, meta);
            if (chat.messagesLoaded) chat.revision = revision;
            return;
        }
        this.chats.unshift(chatFromMeta(meta));
    }

    async applyMessageChanged(
        chatId: string,
        messageId: string,
        revision: number
    ): Promise<void> {
        this.searchCache?.delete(chatId);
        this.allChatsSearched = false;
        const chat = this.findChat(chatId);
        if (!chat?.messagesLoaded || this.allStreamingChatIds.has(chatId))
            return;
        if (revision <= (chat.revision ?? 0)) return;
        if (revision !== (chat.revision ?? 0) + 1) {
            await this.refreshChatFromIDB(chatId, {
                context: 'message revision gap',
                userMessage: "Couldn't synchronize the conversation",
            });
            return;
        }
        try {
            const stored = await loadChat(chatId, messageId);
            if (
                !stored ||
                this.allStreamingChatIds.has(chatId) ||
                this.findChat(chatId) !== chat
            )
                return;
            if (stored.revision !== revision) {
                await this.refreshChatFromIDB(chatId, {
                    context: 'concurrent message changes',
                    userMessage: "Couldn't synchronize the conversation",
                });
                return;
            }
            const index = chat.messages.findIndex((m) => m.id === messageId);
            const message = stored.messages[0]?.message;
            if (index >= 0) {
                if (message) chat.messages[index] = message;
                else chat.messages.splice(index, 1);
            } else if (message) {
                chat.messages.push(message);
                chat.messages.sort(
                    (a, b) =>
                        a.metadata.createdAt - b.metadata.createdAt ||
                        a.id.localeCompare(b.id)
                );
            }
            chat.revision = revision;
            if (this.searchQuery) this.search(this.searchQuery);
        } catch (error) {
            reportAppError(
                'message synchronization failed',
                "Couldn't synchronize the conversation",
                error
            );
        }
    }

    rename(id: string, newTitle: string): void {
        log.info('rename chat', id, newTitle);
        const chat = this.findChat(id);
        if (!chat) return;
        chat.title = newTitle;
        if (!this.demoMode)
            saveMeta(chatToMeta(chat)).catch((err) => {
                reportAppError(
                    `rename save failed (id=${id})`,
                    "Couldn't rename chat",
                    err
                );
            });
    }

    private transferInfo(meta: {
        title: string;
        createdAt: number;
        systemPrompt: string;
        providerId: string;
        modelId: string;
    }): TransferChatInfo {
        return {
            title: meta.title,
            createdAt: meta.createdAt,
            systemPrompt: meta.systemPrompt,
            providerId: meta.providerId,
            modelId: meta.modelId,
        };
    }

    async export(id: string, format: ChatExportFormat): Promise<void> {
        const chat = this.findChat(id);
        if (!chat) return;

        let messages = chat.messages;
        if (!chat.messagesLoaded) {
            try {
                const full = await loadChat(id);
                if (full) messages = storedToMessages(full.messages);
            } catch (err) {
                reportAppError(
                    `export: loadChat failed (id=${id})`,
                    "Couldn't load chat for export",
                    err
                );
                return;
            }
        }

        const info = this.transferInfo(chat);
        let content: string;
        let filename: string;
        let mimeType: string;
        if (format === 'airmailai') {
            content = buildAirmailAIJsonExport(info, messages);
            filename = exportFilename(chat.title, chat.createdAt, '.json');
            mimeType = 'application/json';
        } else if (format === 'lmstudio') {
            content = buildJsonExport(info, messages);
            filename = `${chat.createdAt}.conversation.json`;
            mimeType = 'application/json';
        } else if (format === 'sillytavern') {
            content = buildSillyTavernExport(info, messages);
            filename = sillyTavernFilename(chat.title, chat.createdAt);
            mimeType = 'text/plain';
        } else {
            content = buildMarkdownExport(info, messages);
            filename = exportFilename(chat.title, chat.createdAt, '.md');
            mimeType = 'text/markdown';
        }
        triggerBlobDownload(filename, new Blob([content], { type: mimeType }));
        log.info('exported chat', id, filename);
    }

    async exportAllChats(): Promise<void> {
        let metas: ChatMeta[];
        try {
            metas = await loadChatMetas();
        } catch (err) {
            reportAppError(
                'exportAllChats: metas failed',
                "Couldn't load chat list for backup",
                err
            );
            return;
        }
        if (metas.length === 0) {
            reportAppError(
                'exportAllChats: nothing to export',
                'There are no chats to back up',
                new Error('no chats')
            );
            return;
        }
        const sorted = metas.slice().sort((a, b) => a.createdAt - b.createdAt);
        const parts: Blob[] = [];
        let exported = 0;
        try {
            for (const meta of sorted) {
                const stored = await loadChat(meta.id);
                if (!stored) {
                    throw new Error(
                        `Conversation "${meta.title}" was deleted during backup. Please try again.`
                    );
                }
                const content = buildBackupExport([
                    {
                        info: this.transferInfo(meta),
                        messages: storedToMessages(stored.messages),
                    },
                ]);
                parts.push(new Blob([exported ? '---\n' : '', content]));
                exported++;
            }
        } catch (err) {
            reportAppError(
                'exportAllChats: chats failed',
                "Couldn't load chats for backup",
                err
            );
            return;
        }
        triggerBlobDownload(
            backupFilename(new Date()),
            new Blob(parts, {
                type: 'application/yaml',
            })
        );
        log.info('exported backup', `${exported} chats`);
    }

    private resolveImportedModel(
        model: string | null
    ): { providerId: string; modelId: string } | null {
        if (!model) return null;
        const slash = model.indexOf('/');
        if (slash <= 0) return null;
        const providerId = model.slice(0, slash);
        const modelId = model.slice(slash + 1);
        const provider = providersStore.providers.find(
            (p) => p.id === providerId
        );
        if (!provider) return null;
        if (!provider.models.some((m) => m.id === modelId)) return null;
        return { providerId, modelId };
    }

    private buildImportedChat(imp: ImportedChat): Chat {
        const createdAt = imp.createdAt || Date.now();
        const resolved = this.resolveImportedModel(imp.model);
        const messages: Message[] = imp.messages.map((m, i) => ({
            id: crypto.randomUUID(),
            role: m.role,
            parts: [{ type: 'text', text: m.text, state: 'done' }],
            metadata: { createdAt: createdAt + i },
        }));
        return {
            id: crypto.randomUUID(),
            title: imp.title || 'Imported Chat',
            messages,
            messagesLoaded: true,
            createdAt,
            lastMessageAt: messages.length
                ? messages[messages.length - 1].metadata.createdAt
                : createdAt,
            ...settingsStore.snapshotChatConfig(),
            ...(resolved ?? {}),
            systemPrompt: imp.systemPrompt,
        };
    }

    private async persistImportedChats(chats: Chat[]): Promise<Chat[]> {
        if (this.demoMode) return chats;
        const saved: Chat[] = [];
        let batch: Chat[] = [];
        let batchChars = 0;
        const flush = async () => {
            if (batch.length === 0) return;
            const entries = batch.map((chat) => ({
                meta: chatToMeta(chat),
                messages: chat.messages,
            }));
            try {
                await importChats(entries);
                saved.push(...batch);
            } catch (err) {
                reportAppError(
                    `import: save failed (${batch.length} chats)`,
                    `Couldn't save ${batch.length} imported chat${batch.length === 1 ? '' : 's'}`,
                    err
                );
            }
            batch = [];
            batchChars = 0;
        };
        for (const chat of chats) {
            const chars = chat.messages.reduce(
                (total, m) => total + messageText(m).length,
                0
            );
            if (batch.length > 0 && batchChars + chars > IMPORT_BATCH_CHARS) {
                await flush();
            }
            batch.push(chat);
            batchChars += chars;
        }
        await flush();
        return saved;
    }

    async importChatFile(file: File): Promise<number> {
        if (file.size > MAX_IMPORT_FILE_BYTES) {
            reportAppError(
                `import: file too large (${file.name})`,
                `Couldn't import ${file.name}`,
                new Error(`file is too large (${file.size} bytes)`)
            );
            return 0;
        }
        let result: ChatTransferParseResult;
        try {
            const text = await file.text();
            result = parseChatTransferFile(file.name, text);
        } catch (err) {
            reportAppError(
                `import: parse failed (${file.name})`,
                `Couldn't import ${file.name}`,
                err
            );
            return 0;
        }
        if (result.skipped.length) {
            reportAppError(
                `import: skipped records (${file.name})`,
                `Skipped ${result.skipped.length} unreadable chat${result.skipped.length === 1 ? '' : 's'} in ${file.name}`,
                new Error(result.skipped.join('; '))
            );
        }
        const saved = await this.persistImportedChats(
            result.chats.map((chat) => this.buildImportedChat(chat))
        );
        this.chats.push(...saved);
        if (saved.length === 1) {
            await this.activate(saved[0].id);
        }
        log.info('imported chats', `${saved.length} from ${file.name}`);
        return saved.length;
    }

    editMessage(index: number, content: string): void {
        const chat = this.activeChat;
        if (!chat) return;
        const chatId = chat.id;
        const target = chat.messages[index];
        if (!target) return;
        const nonText = target.parts.filter(
            (p) => p.type !== 'text' && p.type !== 'citation'
        );
        const newParts: AirmailAIMessage['parts'] = [
            ...(content
                ? [
                      {
                          type: 'text' as const,
                          text: content,
                          state: 'done' as const,
                      },
                  ]
                : []),
            ...nonText,
        ];
        chat.messages[index] = { ...target, parts: newParts };
        const editedMsg = chat.messages[index];
        if (!this.demoMode) {
            putMessage(toStoredMessage(chatId, editedMsg)).catch((err) => {
                reportAppError(
                    `edit save failed (chatId=${chatId})`,
                    "Couldn't save edited message",
                    err
                );
            });
        }
    }

    deleteMessage(index: number): void {
        const chat = this.activeChat;
        if (!chat) return;
        const chatId = chat.id;
        const removedId = chat.messages[index]?.id;
        chat.messages.splice(index, 1);
        if (removedId && !this.demoMode)
            deleteMessage(chatId, removedId).catch((err) => {
                reportAppError(
                    `delete-msg save failed (chatId=${chatId})`,
                    "Couldn't delete message",
                    err
                );
            });
    }

    async deleteMessageFile(index: number, key: string): Promise<void> {
        const chat = this.activeChat;
        if (!chat) return;
        const chatId = chat.id;
        const target = chat.messages[index];
        if (!target) return;
        if (!target.parts.some((p) => p.type === 'file' && p.hash === key))
            return;
        const updated = {
            ...target,
            parts: target.parts.filter(
                (p) => !(p.type === 'file' && p.hash === key)
            ),
        };
        chat.messages[index] = updated;
        if (!this.demoMode) {
            putMessage(toStoredMessage(chatId, updated)).catch((err) => {
                reportAppError(
                    `delete-file save failed (chatId=${chatId})`,
                    "Couldn't remove the file",
                    err
                );
            });
        }
    }

    private chatCreationInFlight: Promise<string> | null = null;

    private async ensureActiveChat(): Promise<string> {
        if (this.chatCreationInFlight) return this.chatCreationInFlight;
        if (this.activeChatId) return this.activeChatId;
        this.chatCreationInFlight = this.createBlankChat();
        try {
            return await this.chatCreationInFlight;
        } finally {
            this.chatCreationInFlight = null;
        }
    }

    private async createBlankChat(): Promise<string> {
        const chatId = crypto.randomUUID();
        const chat: Chat = {
            id: chatId,
            title: 'New Chat',
            messages: [],
            messagesLoaded: true,
            createdAt: Date.now(),
            ...settingsStore.snapshotChatConfig(),
        };
        this.chats.unshift(chat);
        this.activeChatId = chatId;
        if (!this.demoMode) await saveMeta(chatToMeta(chat));
        return chatId;
    }

    async prepareAttachmentUpload(): Promise<string> {
        const chatId = await this.ensureActiveChat();
        const chat = this.findChat(chatId);
        if (!chat) throw new Error('The destination chat was deleted.');
        if (!this.demoMode) await saveMeta(chatToMeta(chat));
        return chatId;
    }

    async addDraftAttachment(
        chatId: string,
        replicateTo: string | undefined,
        attachment: DraftAttachmentMeta,
        file: File,
        onProgress?: (progress: number) => void
    ): Promise<{ chatId: string; attachment: DraftAttachment } | null> {
        if (this.demoMode) return null;
        if (!this.findChat(chatId)) {
            throw new Error('The destination chat was deleted.');
        }
        const staged = await stageDraftAttachment(
            chatId,
            attachment,
            file,
            replicateTo,
            onProgress
        );
        const chat = this.findChat(chatId);
        if (
            chat &&
            !chat.draftAttachments?.some((a) => a.hash === staged.hash)
        ) {
            chat.draftAttachments = [...(chat.draftAttachments ?? []), staged];
        }
        return { chatId, attachment: staged };
    }

    async removeDraftAttachment(
        key: string,
        targetChatId?: string
    ): Promise<void> {
        const chatId = targetChatId ?? this.activeChatId;
        if (!chatId) return;
        const chat = this.findChat(chatId);
        if (chat) {
            chat.draftAttachments = (chat.draftAttachments ?? []).filter(
                (d) => d.hash !== key
            );
        }
        if (!this.demoMode) await reqRemoveDraftAttachment(chatId, key);
    }

    async clearActiveDraftAttachments(): Promise<void> {
        const chat = this.activeChat;
        if (!chat) return;
        chat.draftAttachments = [];
        if (!this.demoMode) await clearDraftAttachments(chat.id);
    }

    async sendMessage(content: string): Promise<boolean> {
        if (
            this.activeChatId &&
            (this.streamingChatIds.has(this.activeChatId) ||
                this.remoteStreamingChatIds.has(this.activeChatId))
        )
            return false;

        let chatId = this.activeChatId;
        let createdNewChat = false;
        let previousChat: Chat | null = null;
        if (!chatId) {
            chatId = crypto.randomUUID();
            createdNewChat = true;
            this.chats.unshift({
                id: chatId,
                title: chatTitleFor(content, []),
                messages: [],
                messagesLoaded: true,
                createdAt: Date.now(),
                ...settingsStore.snapshotChatConfig(),
            });
            this.activeChatId = chatId;
        } else {
            const existing = this.findChat(chatId);
            if (!existing || !existing.messagesLoaded) {
                reportAppError(
                    `sendMessage: chat not loaded (id=${chatId})`,
                    'This chat is still loading, try again in a moment',
                    new Error(
                        existing
                            ? 'active chat messages not loaded yet'
                            : 'active chat missing from memory'
                    )
                );
                return false;
            }
            previousChat = snapshotChat(existing);
            const isFirst = existing.messages.length === 0;
            Object.assign(existing, settingsStore.snapshotChatConfig());
            if (isFirst)
                existing.title = chatTitleFor(
                    content,
                    existing.draftAttachments ?? []
                );
        }

        const chat = this.findChat(chatId);
        if (!chat) return false;
        const draftAttachments = chat.draftAttachments ?? [];
        log.info('send message', {
            provider: settingsStore.providerId,
            model: settingsStore.modelId,
            contentLength: content.length,
            attachmentCount: draftAttachments.length,
            existingChat: chatId,
        });

        const userMsg = buildUserMessage(
            crypto.randomUUID(),
            Date.now(),
            content,
            draftAttachments
        );
        const assistantId = crypto.randomUUID();
        const assistantPlaceholder = buildAssistantPlaceholder(
            assistantId,
            userMsg.metadata.createdAt + 1
        );

        chat.messages.push(userMsg, assistantPlaceholder);
        chat.draftAttachments = [];
        chat.lastMessageAt = Date.now();

        this.streamingChatIds.add(chatId);
        this.clearChatError(chatId);

        if (this.demoMode) {
            this.streamForChat(chatId, assistantId);
            return true;
        }

        const id = chatId;
        try {
            chat.revision = await prepareTurn(
                chatToMeta(chat),
                toStoredMessage(id, userMsg)
            );
        } catch (err) {
            this.streamingChatIds.delete(id);
            if (createdNewChat) {
                const index = this.chats.findIndex((item) => item.id === id);
                if (index >= 0) this.chats.splice(index, 1);
                if (this.activeChatId === id) this.activeChatId = null;
            } else if (previousChat) {
                const index = this.chats.findIndex((item) => item.id === id);
                if (index >= 0) this.chats[index] = previousChat;
            }
            reportAppError(
                createdNewChat
                    ? 'prepare new chat turn failed'
                    : 'prepare turn failed',
                "Couldn't save your message",
                err
            );
            return false;
        }
        this.streamForChat(id, assistantId);
        return true;
    }

    async retry(index: number): Promise<void> {
        const chat = this.activeChat;
        if (!chat) return;
        const chatId = chat.id;
        this.abortLocalStream(chatId);
        const msg = chat.messages[index];
        if (!msg) return;
        const keepUpTo = msg.role === 'user' ? index : index - 1;
        if (keepUpTo < 0) return;
        const previousChat = snapshotChat(chat);

        const lastKeptMsg = chat.messages[keepUpTo];
        const assistantId = crypto.randomUUID();
        const assistantPlaceholder = buildAssistantPlaceholder(
            assistantId,
            Math.max(Date.now(), lastKeptMsg.metadata.createdAt + 1)
        );

        Object.assign(chat, settingsStore.snapshotChatConfig());
        chat.lastMessageAt = Date.now();
        chat.messages.splice(
            keepUpTo + 1,
            chat.messages.length - (keepUpTo + 1),
            assistantPlaceholder
        );

        this.clearChatError(chatId);
        this.streamingChatIds.add(chatId);

        if (this.demoMode) {
            this.streamForChat(chatId, assistantId);
            return;
        }

        try {
            chat.revision = await prepareRetry(
                chatToMeta(chat),
                lastKeptMsg.id
            );
        } catch (err) {
            this.streamingChatIds.delete(chatId);
            const currentIndex = this.chats.findIndex(
                (item) => item.id === chatId
            );
            if (currentIndex >= 0) this.chats[currentIndex] = previousChat;
            reportAppError(
                'prepare retry failed',
                "Couldn't prepare chat retry",
                err
            );
            return;
        }
        this.streamForChat(chatId, assistantId);
    }

    stop(visibleChars: number): void {
        const chat = this.activeChat;
        if (!chat) return;
        const handle = this.streamHandles.get(chat.id);
        if (!handle) return;
        handle.stop(visibleChars);
        this.streamBatchers.get(chat.id)?.discard();
        const last = chat.messages[chat.messages.length - 1];
        if (last && last.role === 'assistant') {
            truncateMessageTextParts(last, visibleChars);
            chat.streamingText = messageText(last);
        }
    }

    private streamForChat(chatId: string, assistantId: string): void {
        const chat = this.findChat(chatId);
        if (!chat) {
            this.streamingChatIds.delete(chatId);
            return;
        }

        const selectedModel = providersStore.providers
            .find((p) => p.id === chat.providerId)
            ?.models.find((m) => m.id === chat.modelId);
        const modelParams = selectedModel?.params;
        const wireTools: Record<string, string | boolean> = {};
        const modelTools = selectedModel?.tools;
        if (
            modelTools?.webSearch &&
            settingsStore.enableWebSearch &&
            chat.webSearch
        ) {
            wireTools.webSearch = modelTools.webSearch;
        }
        if (
            modelTools?.webFetch &&
            settingsStore.enableWebFetch &&
            chat.webFetch
        ) {
            wireTools.webFetch = modelTools.webFetch;
        }
        if (
            modelTools?.codeExecution &&
            settingsStore.enableCodeExecution &&
            chat.codeExecution
        ) {
            wireTools.codeExecution = modelTools.codeExecution;
        }
        const mayHaveContainerOutputs =
            chat.providerId === 'openai' && !!wireTools.codeExecution;
        const assistantRef = chat.messages[chat.messages.length - 1];
        const assembler = createMessageAssembler(assistantRef);
        const batcher = createStreamBatcher(assembler, chat);
        chat.streamingText = '';

        const finishStream = () => {
            batcher.flush();
            this.streamHandles.delete(chatId);
            this.streamBatchers.delete(chatId);
            this.streamingChatIds.delete(chatId);
            chat.streamingText = null;
            versionCheck.maybeCheckWebVersion();
        };

        const handle = sendToExtension(
            {
                chatId,
                sourceTabId: tabId,
                provider: chat.providerId,
                model: chat.modelId,
                ...(chat.systemPrompt.trim()
                    ? { system: chat.systemPrompt }
                    : {}),
                params: {
                    ...(modelParams?.temperatureMax !== undefined
                        ? { temperature: chat.temperature }
                        : {}),
                    maxTokens: chat.maxTokens,
                    ...(modelParams?.thinking
                        ? {
                              thinkingLevel: chat.thinkingLevel,
                              adaptiveThinking: chat.adaptiveThinking,
                          }
                        : {}),
                    tools: wireTools,
                    tagOpenRouterRequests: settingsStore.tagOpenRouterRequests,
                    openRouterPdfEngine: settingsStore.openRouterPdfEngine,
                },
                meta: chatToMeta(chat),
                assistantMessageId: assistantId,
                assistantCreatedAt: assistantRef.metadata.createdAt,
            },
            {
                onChunk: (chunk) => batcher.push(chunk),
                onDone: (revision) => {
                    chat.revision = revision;
                    finishStream();
                    if (mayHaveContainerOutputs) {
                        void this.refreshChatFromIDB(chatId, {
                            context: 'onDone: refresh after file capture',
                            userMessage: "Couldn't refresh chat from storage",
                        });
                    }
                },
                onError: (msg, source, revision) => {
                    if (revision !== undefined) chat.revision = revision;
                    finishStream();
                    this.chatErrors = {
                        ...this.chatErrors,
                        [chatId]: formatStreamError(msg, source),
                    };
                    if (!assistantRef.parts.length) {
                        const idx = chat.messages.findIndex(
                            (m) => m.id === assistantId
                        );
                        if (idx >= 0) chat.messages.splice(idx, 1);
                    }
                },
            }
        );
        this.streamHandles.set(chatId, handle);
        this.streamBatchers.set(chatId, batcher);
    }

    applyRemoteTurnStart(
        chatId: string,
        meta: ChatMeta,
        assistantMessageId: string,
        assistantCreatedAt: number
    ): void {
        const placeholder = buildAssistantPlaceholder(
            assistantMessageId,
            assistantCreatedAt
        );
        let chat = this.findChat(chatId);
        if (chat) {
            chat.messages = [
                ...chat.messages.filter((m) => m.id !== assistantMessageId),
                placeholder,
            ];
        } else {
            this.chats.unshift({
                ...meta,
                messages: [placeholder],
                messagesLoaded: false,
            });
            chat = this.findChat(chatId)!;
        }
        this.remoteStreamingChatIds.add(chatId);
        this.clearChatError(chatId);

        this.closeRemotePipeline(chatId);
        const assistantRef = chat.messages[chat.messages.length - 1];
        const assembler = createMessageAssembler(assistantRef);
        chat.streamingText = '';
        this.remotePipelines.set(chatId, {
            assembler,
            batcher: createStreamBatcher(assembler, chat),
            placeholderId: assistantMessageId,
            chat,
        });

        void this.backfillRemoteHistory(chatId, assistantMessageId);
    }

    private async backfillRemoteHistory(
        chatId: string,
        assistantMessageId: string
    ): Promise<void> {
        let stored: StoredChat | null;
        try {
            stored = await loadChat(chatId);
        } catch (err) {
            reportAppError(
                'remote turn-start: loadChat failed',
                "Couldn't refresh chat from storage",
                err
            );
            return;
        }
        if (!stored) return;
        const pipeline = this.remotePipelines.get(chatId);
        if (!pipeline || pipeline.placeholderId !== assistantMessageId) return;
        const assistantRef =
            pipeline.chat.messages[pipeline.chat.messages.length - 1];
        const history = storedToMessages(
            stored.messages.filter((s) => s.message.id !== assistantMessageId)
        );
        pipeline.chat.messages = [...history, assistantRef];
        pipeline.chat.revision = stored.revision;
        pipeline.chat.messagesLoaded = true;
    }

    applyRemoteTurnChunk(chatId: string, chunk: AirmailAIChunk): void {
        if (!this.remoteStreamingChatIds.has(chatId)) return;
        const pipeline = this.remotePipelines.get(chatId);
        if (!pipeline) return;
        try {
            pipeline.batcher.push(chunk);
        } catch (e) {
            log.warn('remote chunk apply failed', e);
        }
    }

    applyRemoteTurnTruncate(chatId: string, charLen: number): void {
        if (!this.remoteStreamingChatIds.has(chatId)) return;
        const pipeline = this.remotePipelines.get(chatId);
        if (!pipeline) return;
        pipeline.batcher.discard();
        const chat = pipeline.chat;
        const last = chat.messages[chat.messages.length - 1];
        if (!last || last.role !== 'assistant') return;
        truncateMessageTextParts(last, charLen);
        chat.streamingText = messageText(last);
    }

    private closeRemotePipeline(chatId: string): void {
        const pipeline = this.remotePipelines.get(chatId);
        if (!pipeline) return;
        pipeline.batcher.flush();
        pipeline.chat.streamingText = null;
        this.remotePipelines.delete(chatId);
    }

    private async refreshChatFromIDB(
        chatId: string,
        opts: {
            context: string;
            userMessage: string | null;
            onMissing?: 'keep' | 'drop';
        }
    ): Promise<void> {
        let stored: StoredChat | null;
        try {
            stored = await loadChat(chatId);
        } catch (err) {
            if (opts.userMessage) {
                reportAppError(opts.context, opts.userMessage, err);
            } else {
                log.error(opts.context, err);
            }
            return;
        }
        if (stored) {
            const chat = this.findChat(chatId);
            if (
                chat &&
                !this.allStreamingChatIds.has(chatId) &&
                stored.revision >= (chat.revision ?? 0)
            ) {
                chat.messages = storedToMessages(stored.messages);
                chat.revision = stored.revision;
                chat.messagesLoaded = true;
            }
        } else if (opts.onMissing === 'drop') {
            const idx = this.chats.findIndex((c) => c.id === chatId);
            if (idx >= 0) this.chats.splice(idx, 1);
            if (this.activeChatId === chatId) this.activeChatId = null;
        }
    }

    async applyRemoteTurnDone(chatId: string): Promise<void> {
        if (!this.remoteStreamingChatIds.has(chatId)) return;
        this.remoteStreamingChatIds.delete(chatId);
        this.closeRemotePipeline(chatId);
        await this.refreshChatFromIDB(chatId, {
            context: 'applyRemoteTurnDone: loadChat failed',
            userMessage: "Couldn't refresh chat from storage",
        });
    }

    async applyRemoteTurnAborted(chatId: string): Promise<void> {
        if (!this.remoteStreamingChatIds.has(chatId)) return;
        this.remoteStreamingChatIds.delete(chatId);
        this.closeRemotePipeline(chatId);
        await this.refreshChatFromIDB(chatId, {
            context: 'applyRemoteTurnAborted: loadChat failed',
            userMessage: "Couldn't refresh chat from storage",
            onMissing: 'drop',
        });
    }

    async applyRemoteTurnError(
        chatId: string,
        message: string,
        source: StreamErrorSource = 'api'
    ): Promise<void> {
        if (!this.remoteStreamingChatIds.has(chatId)) return;
        this.remoteStreamingChatIds.delete(chatId);
        this.closeRemotePipeline(chatId);
        this.chatErrors = {
            ...this.chatErrors,
            [chatId]: formatStreamError(message, source),
        };
        await this.refreshChatFromIDB(chatId, {
            context: 'applyRemoteTurnError: loadChat failed',
            userMessage: null,
        });
    }

    syncActiveTurns(activeChatIds: string[]): string[] {
        if (this.demoMode) return [];
        const active = new Set(activeChatIds);
        const interrupted: string[] = [];
        for (const id of this.remoteStreamingChatIds) {
            if (active.has(id)) continue;
            this.remoteStreamingChatIds.delete(id);
            this.closeRemotePipeline(id);
            interrupted.push(id);
        }
        for (const id of active) {
            if (!this.streamingChatIds.has(id))
                this.remoteStreamingChatIds.add(id);
        }
        return interrupted;
    }

    async reconcileFromIDB(activeChatIds: string[]): Promise<void> {
        if (this.demoMode) return;
        const interrupted = this.syncActiveTurns(activeChatIds);
        let metas: ChatMeta[];
        try {
            metas = await loadChatMetas();
        } catch (err) {
            reportAppError(
                'reconcile: metas failed',
                "Couldn't refresh chats after reconnecting",
                err
            );
            return;
        }
        const metaById = new Map(metas.map((m) => [m.id, m]));
        const staleIds: string[] = [...interrupted];
        for (const chat of [...this.chats]) {
            const streaming = this.allStreamingChatIds.has(chat.id);
            const fresh = metaById.get(chat.id);
            if (fresh) {
                if (
                    !streaming &&
                    chat.messagesLoaded &&
                    (fresh.revision ?? 0) !== (chat.revision ?? 0) &&
                    !staleIds.includes(chat.id)
                ) {
                    staleIds.push(chat.id);
                }
                const revision = chat.revision;
                Object.assign(chat, fresh);
                if (chat.messagesLoaded) chat.revision = revision;
            } else if (
                !streaming &&
                (!chat.messagesLoaded || chat.messages.length > 0)
            ) {
                this.removeLocal(chat.id);
            }
        }
        const knownIds = new Set(this.chats.map((c) => c.id));
        for (const meta of metas) {
            if (!knownIds.has(meta.id)) this.chats.push(chatFromMeta(meta));
        }
        if (staleIds.length > 0) {
            let fullChats: StoredChat[];
            try {
                fullChats = await loadChatsByIds(staleIds);
            } catch (err) {
                reportAppError(
                    'reconcile: chats failed',
                    "Couldn't refresh chats after reconnecting",
                    err
                );
                return;
            }
            for (const stored of fullChats) {
                const chat = this.findChat(stored.id);
                if (
                    chat &&
                    !this.allStreamingChatIds.has(chat.id) &&
                    stored.revision >= (chat.revision ?? 0)
                ) {
                    chat.messages = storedToMessages(stored.messages);
                    chat.revision = stored.revision;
                    chat.messagesLoaded = true;
                }
            }
        }
        log.info(
            'reconciled after reconnect',
            `${metas.length} metas, ${staleIds.length} chats refreshed`
        );
    }

    async refreshLoadedChats(chatIds: string[]): Promise<void> {
        this.fileStatusVersion++;
        for (const id of chatIds) {
            if (!this.findChat(id)?.messagesLoaded) continue;
            await this.refreshChatFromIDB(id, {
                context: 'refreshLoadedChats: loadChat failed',
                userMessage: "Couldn't refresh chat after deleting a file",
            });
        }
    }
}

export const chatStore = new ChatStore();
