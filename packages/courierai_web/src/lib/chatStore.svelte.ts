import type {
    ChatMeta,
    CourierAIChunk,
    CourierAIMessage,
    DraftAttachment,
    HydratedStoredMessage,
    MessageAssemblerState,
    StoredChat,
    StoredMessage,
    StreamErrorSource,
} from '@courierai/shared';
import { applyCourierAIChunk, createMessageAssembler } from '@courierai/shared';
import { SvelteSet } from 'svelte/reactivity';
import {
    buildBackupExport,
    buildCourierAIJsonExport,
    buildJsonExport,
    buildMarkdownExport,
    buildSillyTavernExport,
    downloadTextFile,
    exportFilename,
    MAX_IMPORT_FILE_BYTES,
    parseChatTransferFile,
    sillyTavernFilename,
    type ChatExportFormat,
    type ChatTransferParseResult,
    type ImportedChat,
    type TransferChatEntry,
    type TransferChatInfo,
} from './chatTransfer';
import { buildDemoChats } from './demo';
import { reportAppError } from './errorStore.svelte';
import {
    clearDraftAttachments,
    deleteChat,
    deleteMessage,
    deleteMessagesAfter,
    loadChat,
    loadChatMetas,
    loadChatsByIds,
    putMessage,
    removeDraftAttachment as reqRemoveDraftAttachment,
    saveMeta,
    sendToExtension,
    stageDraftAttachment,
    type StreamHandle,
    tabId,
} from './extension';
import { providersStore } from './providersStore.svelte';
import { settingsStore } from './settingsStore.svelte';
import {
    messageText,
    truncateMessageTextParts,
    type Chat,
    type Message,
    type SearchResult,
} from './types';

import { log } from './log';
const INITIAL_PAGE_SIZE = 40;
const LOAD_MORE_PAGE_SIZE = 15;

function formatStreamError(message: string, source: StreamErrorSource): string {
    return `${source === 'extension' ? 'Ext' : 'API'} Error: ${message}`;
}

function buildUserMessage(
    id: string,
    createdAt: number,
    content: string,
    attachments?: DraftAttachment[]
): CourierAIMessage {
    const parts: CourierAIMessage['parts'] = [];
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
): CourierAIMessage {
    return {
        id,
        role: 'assistant',
        parts: [],
        metadata: { createdAt },
    };
}

function messageToHydrated(
    chatId: string,
    msg: CourierAIMessage
): HydratedStoredMessage {
    return { chatId, message: msg };
}

function chatToMeta(chat: Chat): ChatMeta {
    return {
        id: chat.id,
        title: chat.title,
        createdAt: chat.createdAt,
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

interface RemoteStreamPipeline {
    assembler: MessageAssemblerState;
    placeholderId: string;
    chat: Chat;
}

class ChatStore {
    chats = $state<Chat[]>([]);
    unloadedMetas = $state<ChatMeta[]>([]);
    activeChatId = $state<string | null>(null);
    streamingChatIds = new SvelteSet<string>();
    remoteStreamingChatIds = new SvelteSet<string>();
    chatErrors = $state<Record<string, string>>({});
    searchResults = $state<SearchResult[] | null>(null);
    searchQuery = $state('');
    highlightMessageIndex = $state<number | null>(null);
    chatLoading = $state(false);
    isLoadingMore = $state(false);
    demoMode = $state(false);
    private streamHandles = new Map<string, StreamHandle>();
    private remotePipelines = new Map<string, RemoteStreamPipeline>();
    hasMoreChats = $derived(this.unloadedMetas.length > 0);
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
    activeMessages = $derived(
        this.chats.find((c) => c.id === this.activeChatId)?.messages ?? []
    );
    activeDraftAttachments = $derived(
        this.chats.find((c) => c.id === this.activeChatId)?.draftAttachments ??
            []
    );
    activeStreamingText = $derived(
        this.chats.find((c) => c.id === this.activeChatId)?.streamingText ??
            null
    );
    activeTokens = $derived.by(() => {
        const msgs =
            this.chats.find((c) => c.id === this.activeChatId)?.messages ?? [];
        for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (m.role === 'assistant' && m.metadata?.tokens) {
                return m.metadata.tokens;
            }
        }
        return null;
    });

    private storedToMessages(stored: StoredMessage[]): Message[] {
        return stored.map((s) => s.message);
    }

    async loadInitialPage(): Promise<void> {
        let metas: ChatMeta[];
        try {
            metas = await loadChatMetas();
        } catch (err) {
            reportAppError(
                'loadInitialPage: metas failed',
                "Couldn't load chat list",
                err
            );
            return;
        }
        const sorted = metas.sort((a, b) => b.createdAt - a.createdAt);
        log.info('chat metas loaded', `${sorted.length} chats`);

        const firstPage = sorted.slice(0, INITIAL_PAGE_SIZE);
        this.unloadedMetas = sorted.slice(INITIAL_PAGE_SIZE);

        if (firstPage.length > 0) {
            let fullChats: StoredChat[];
            try {
                fullChats = await loadChatsByIds(firstPage.map((m) => m.id));
            } catch (err) {
                reportAppError(
                    'loadInitialPage: chats failed',
                    "Couldn't load chat history",
                    err
                );
                return;
            }
            const byId = new Map(fullChats.map((c) => [c.id, c]));
            this.chats = firstPage
                .map((meta) => {
                    const stored = byId.get(meta.id);
                    if (!stored) return null;
                    return {
                        ...meta,
                        messages: this.storedToMessages(stored.messages),
                    };
                })
                .filter((c): c is Chat => c !== null);
            log.info('first page loaded', `${this.chats.length} chats`);
        }
    }

    async loadMore(): Promise<void> {
        if (this.isLoadingMore || this.unloadedMetas.length === 0) return;
        this.isLoadingMore = true;
        const nextPage = this.unloadedMetas.slice(0, LOAD_MORE_PAGE_SIZE);
        let fullChats: StoredChat[];
        try {
            fullChats = await loadChatsByIds(nextPage.map((m) => m.id));
        } catch (err) {
            reportAppError('loadMore failed', "Couldn't load more chats", err);
            this.isLoadingMore = false;
            return;
        }
        const byId = new Map(fullChats.map((c) => [c.id, c]));
        const newChats = nextPage
            .map((meta) => {
                const stored = byId.get(meta.id);
                if (!stored) return null;
                return {
                    ...meta,
                    messages: this.storedToMessages(stored.messages),
                };
            })
            .filter((c): c is Chat => c !== null);
        this.chats.push(...newChats);
        this.unloadedMetas.splice(0, LOAD_MORE_PAGE_SIZE);
        log.info(
            'loaded more chats',
            `${newChats.length} chats, total ${this.chats.length}`
        );
        this.isLoadingMore = false;
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
        this.unloadedMetas = [];
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
            const result = this.matchChat(
                chat.id,
                chat.title,
                chat.messages,
                q
            );
            if (result) results.push(result);
        }
        if (this.searchCache) {
            for (const meta of this.unloadedMetas) {
                const messages = this.searchCache.get(meta.id);
                if (!messages) continue;
                const result = this.matchChat(meta.id, meta.title, messages, q);
                if (result) results.push(result);
            }
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

    searchingAll = $state(false);
    allChatsSearched = $state(false);
    private searchCache: Map<string, Message[]> | null = null;

    async searchAllChats(): Promise<void> {
        if (
            this.searchingAll ||
            this.allChatsSearched ||
            this.unloadedMetas.length === 0
        )
            return;
        this.searchingAll = true;
        try {
            const fullChats = await loadChatsByIds(
                this.unloadedMetas.map((m) => m.id)
            );
            this.searchCache = new Map(
                fullChats.map((c) => [c.id, this.storedToMessages(c.messages)])
            );
            this.allChatsSearched = true;
            log.info(
                'search cache built',
                `${fullChats.length} unloaded chats`
            );
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
        this.streamHandles.clear();
        this.remotePipelines.clear();
        this.chats = [];
        this.unloadedMetas = [];
        this.activeChatId = null;
        this.streamingChatIds.clear();
        this.remoteStreamingChatIds.clear();
        this.chatErrors = {};
        this.clearSearch();
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
            createdAt: now,
            ...settingsStore.snapshotChatConfig(),
        });
        this.activeChatId = id;
    }

    async activate(id: string, matchIndex?: number | null): Promise<void> {
        this.highlightMessageIndex = matchIndex ?? null;
        log.info('select chat', id);
        this.activeChatId = id;

        const loaded = this.chats.find((c) => c.id === id);
        if (loaded) {
            settingsStore.applyChatConfig(loaded);
            return;
        }

        const meta = this.unloadedMetas.find((t) => t.id === id);
        if (!meta) return;
        settingsStore.applyChatConfig(meta);

        this.chatLoading = true;
        let full: StoredChat | null;
        try {
            full = await loadChat(id);
        } catch (err) {
            reportAppError(
                `activate: loadChat failed (id=${id})`,
                "Couldn't load chat",
                err
            );
            this.chatLoading = false;
            return;
        }
        this.chatLoading = false;

        if (full && this.activeChatId === id) {
            const metaIdx = this.unloadedMetas.findIndex((m) => m.id === id);
            if (metaIdx >= 0) this.unloadedMetas.splice(metaIdx, 1);
            if (!this.chats.some((c) => c.id === id)) {
                const chat: Chat = {
                    ...meta,
                    messages: this.storedToMessages(full.messages),
                };
                const insertIdx = this.chats.findIndex(
                    (c) => c.createdAt < chat.createdAt
                );
                if (insertIdx === -1) this.chats.push(chat);
                else this.chats.splice(insertIdx, 0, chat);
            }
        }
    }

    private removeLocal(id: string): void {
        this.streamHandles.get(id)?.abort();
        this.streamHandles.delete(id);
        const chatIdx = this.chats.findIndex((c) => c.id === id);
        if (chatIdx >= 0) this.chats.splice(chatIdx, 1);
        const metaIdx = this.unloadedMetas.findIndex((t) => t.id === id);
        if (metaIdx >= 0) this.unloadedMetas.splice(metaIdx, 1);
        if (this.activeChatId === id) {
            this.activeChatId = null;
            settingsStore.systemPrompt = '';
            settingsStore.applyToolDefaults(providersStore.selectedModel);
        }
        this.streamingChatIds.delete(id);
        this.remoteStreamingChatIds.delete(id);
        this.closeRemotePipeline(id);
        this.clearChatError(id);
    }

    remove(id: string): void {
        log.info('remove chat', id);
        const removedTitle =
            this.chats.find((c) => c.id === id)?.title ??
            this.unloadedMetas.find((m) => m.id === id)?.title;
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
        const chat = this.chats.find((c) => c.id === meta.id);
        if (chat) {
            Object.assign(chat, meta);
            return;
        }
        const metaIdx = this.unloadedMetas.findIndex((m) => m.id === meta.id);
        if (metaIdx >= 0) {
            this.unloadedMetas[metaIdx] = meta;
            return;
        }
        this.chats.unshift({ ...meta, messages: [] });
    }

    rename(id: string, newTitle: string): void {
        log.info('rename chat', id, newTitle);
        const chat = this.chats.find((c) => c.id === id);
        if (chat) chat.title = newTitle;
        const meta = this.unloadedMetas.find((m) => m.id === id);
        if (meta) meta.title = newTitle;
        if (chat && !this.demoMode)
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
        const chat = this.chats.find((c) => c.id === id);
        if (!chat) return;

        let messages = chat.messages;
        if (messages.length === 0) {
            try {
                const full = await loadChat(id);
                if (full) messages = this.storedToMessages(full.messages);
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
        if (format === 'courierai') {
            content = buildCourierAIJsonExport(info, messages);
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
        downloadTextFile(filename, content, mimeType);
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
        let stored: StoredChat[];
        try {
            stored = await loadChatsByIds(sorted.map((m) => m.id));
        } catch (err) {
            reportAppError(
                'exportAllChats: chats failed',
                "Couldn't load chats for backup",
                err
            );
            return;
        }
        const byId = new Map(stored.map((c) => [c.id, c]));
        const entries: TransferChatEntry[] = sorted.map((meta) => ({
            info: this.transferInfo(meta),
            messages: this.storedToMessages(byId.get(meta.id)?.messages ?? []),
        }));
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        const filename = `courierai-backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}.yaml`;
        downloadTextFile(
            filename,
            buildBackupExport(entries),
            'application/yaml'
        );
        log.info('exported backup', `${entries.length} chats`);
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

    private async addImportedChat(imp: ImportedChat): Promise<string | null> {
        const id = crypto.randomUUID();
        const createdAt = imp.createdAt || Date.now();
        const resolved = this.resolveImportedModel(imp.model);
        const chat: Chat = {
            id,
            title: imp.title || 'Imported Chat',
            messages: [],
            createdAt,
            ...settingsStore.snapshotChatConfig(),
            ...(resolved ?? {}),
            systemPrompt: imp.systemPrompt,
        };
        chat.messages = imp.messages.map((m, i) => ({
            id: crypto.randomUUID(),
            role: m.role,
            parts: [{ type: 'text', text: m.text, state: 'done' }],
            metadata: { createdAt: createdAt + i },
        }));
        if (!this.demoMode) {
            try {
                await saveMeta(chatToMeta(chat));
                for (const msg of chat.messages) {
                    await putMessage(messageToHydrated(id, msg));
                }
            } catch (err) {
                reportAppError(
                    `import: save failed (title=${chat.title})`,
                    `Couldn't save imported chat "${chat.title}"`,
                    err
                );
                return null;
            }
        }
        const insertIdx = this.chats.findIndex(
            (c) => c.createdAt < chat.createdAt
        );
        if (insertIdx === -1) this.chats.push(chat);
        else this.chats.splice(insertIdx, 0, chat);
        return id;
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
        let count = 0;
        let lastId: string | null = null;
        for (const chat of result.chats) {
            const id = await this.addImportedChat(chat);
            if (id) {
                count++;
                lastId = id;
            }
        }
        if (count === 1 && lastId) {
            await this.activate(lastId);
        }
        log.info('imported chats', `${count} from ${file.name}`);
        return count;
    }

    editMessage(index: number, content: string): void {
        if (!this.activeChatId) return;
        const chatId = this.activeChatId;
        const chat = this.chats.find((c) => c.id === chatId);
        if (!chat) return;
        const target = chat.messages[index];
        if (!target) return;
        const nonText = target.parts.filter(
            (p) => p.type !== 'text' && p.type !== 'citation'
        );
        const newParts: CourierAIMessage['parts'] = [
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
            putMessage(messageToHydrated(chatId, editedMsg)).catch((err) => {
                reportAppError(
                    `edit save failed (chatId=${chatId})`,
                    "Couldn't save edited message",
                    err
                );
            });
        }
    }

    deleteMessage(index: number): void {
        if (!this.activeChatId) return;
        const chatId = this.activeChatId;
        const chat = this.chats.find((c) => c.id === chatId);
        const removedId = chat?.messages[index]?.id;
        if (chat) chat.messages.splice(index, 1);
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
        if (!this.activeChatId) return;
        const chatId = this.activeChatId;
        const chat = this.chats.find((c) => c.id === chatId);
        const target = chat?.messages[index];
        if (!chat || !target) return;
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
            putMessage(messageToHydrated(chatId, updated)).catch((err) => {
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
            createdAt: Date.now(),
            ...settingsStore.snapshotChatConfig(),
        };
        this.chats.unshift(chat);
        this.activeChatId = chatId;
        if (!this.demoMode) await saveMeta(chatToMeta(chat));
        return chatId;
    }

    async addDraftAttachment(
        attachment: DraftAttachment,
        base64: string
    ): Promise<void> {
        if (this.demoMode) return;
        const chatId = await this.ensureActiveChat();
        const activeChat = this.chats.find((c) => c.id === chatId);
        if (activeChat) await saveMeta(chatToMeta(activeChat));
        const replicateTo = settingsStore.enableProviderFileStorage
            ? (activeChat?.providerId ?? settingsStore.providerId)
            : undefined;
        const warning = await stageDraftAttachment(
            chatId,
            attachment,
            base64,
            replicateTo
        );
        if (warning) {
            reportAppError(
                `draft replica upload failed (chatId=${chatId})`,
                `Saved ${attachment.name} on this device, but couldn't copy it to ${replicateTo} storage (will retry when you send)`,
                new Error(warning)
            );
        }
        const chat = this.chats.find((c) => c.id === chatId);
        if (chat) {
            chat.draftAttachments = [
                ...(chat.draftAttachments ?? []),
                attachment,
            ];
        }
    }

    async removeDraftAttachment(key: string): Promise<void> {
        const chatId = this.activeChatId;
        if (!chatId) return;
        const chat = this.chats.find((c) => c.id === chatId);
        if (chat) {
            chat.draftAttachments = (chat.draftAttachments ?? []).filter(
                (d) => d.hash !== key
            );
        }
        if (!this.demoMode) await reqRemoveDraftAttachment(chatId, key);
    }

    async clearActiveDraftAttachments(): Promise<void> {
        const chatId = this.activeChatId;
        if (!chatId) return;
        const chat = this.chats.find((c) => c.id === chatId);
        if (chat) chat.draftAttachments = [];
        if (!this.demoMode) await clearDraftAttachments(chatId);
    }

    sendMessage(content: string): void {
        if (
            this.activeChatId &&
            (this.streamingChatIds.has(this.activeChatId) ||
                this.remoteStreamingChatIds.has(this.activeChatId))
        )
            return;

        let chatId = this.activeChatId;
        let createdNewChat = false;
        if (!chatId) {
            chatId = crypto.randomUUID();
            createdNewChat = true;
            this.chats.unshift({
                id: chatId,
                title: content.slice(0, 40),
                messages: [],
                createdAt: Date.now(),
                ...settingsStore.snapshotChatConfig(),
            });
            this.activeChatId = chatId;
        } else {
            const existing = this.chats.find((c) => c.id === chatId);
            if (!existing) {
                reportAppError(
                    `sendMessage: chat not loaded (id=${chatId})`,
                    'This chat is still loading, try again in a moment',
                    new Error('active chat missing from memory')
                );
                return;
            }
            const isFirst = existing.messages.length === 0;
            Object.assign(existing, settingsStore.snapshotChatConfig());
            if (isFirst) existing.title = content.slice(0, 40);
        }

        const sendChat = this.chats.find((c) => c.id === chatId);
        const draftAttachments = sendChat?.draftAttachments ?? [];
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
            Date.now()
        );

        if (sendChat) {
            sendChat.messages.push(userMsg, assistantPlaceholder);
            sendChat.draftAttachments = [];
        }

        this.streamingChatIds.add(chatId);
        this.clearChatError(chatId);

        if (this.demoMode) {
            this.streamForChat(chatId, assistantId);
            return;
        }

        const chat = this.chats.find((c) => c.id === chatId);
        if (!chat) {
            this.streamingChatIds.delete(chatId);
            return;
        }
        const id = chatId;
        void (async () => {
            try {
                await saveMeta(chatToMeta(chat));
            } catch (err) {
                reportAppError(
                    createdNewChat
                        ? 'persist new chat failed'
                        : 'persist meta failed',
                    "Couldn't save chat",
                    err
                );
            }
            try {
                await putMessage(messageToHydrated(id, userMsg));
                if (draftAttachments.length) {
                    await clearDraftAttachments(id);
                }
            } catch (err) {
                reportAppError(
                    'persist user msg failed',
                    "Couldn't save your message",
                    err
                );
            }
            this.streamForChat(id, assistantId);
        })();
    }

    retry(index: number): void {
        if (!this.activeChatId) return;
        const chatId = this.activeChatId;
        const chat = this.chats.find((c) => c.id === chatId);
        if (!chat) return;
        this.streamHandles.get(chatId)?.abort();
        this.streamHandles.delete(chatId);
        this.streamingChatIds.delete(chatId);
        const msg = chat.messages[index];
        if (!msg) return;
        const keepUpTo = msg.role === 'user' ? index : index - 1;
        if (keepUpTo < 0) return;

        const lastKeptMsg = chat.messages[keepUpTo];
        const assistantId = crypto.randomUUID();
        const assistantPlaceholder = buildAssistantPlaceholder(
            assistantId,
            Date.now()
        );

        Object.assign(chat, settingsStore.snapshotChatConfig());
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

        void (async () => {
            try {
                await saveMeta(chatToMeta(chat));
            } catch (err) {
                reportAppError(
                    'retry: meta save failed',
                    "Couldn't save chat config",
                    err
                );
            }
            try {
                await deleteMessagesAfter(chatId, lastKeptMsg.id);
            } catch (err) {
                reportAppError(
                    'retry: truncate failed',
                    "Couldn't truncate chat history",
                    err
                );
            }
            this.streamForChat(chatId, assistantId);
        })();
    }

    stop(visibleChars: number): void {
        if (!this.activeChatId) return;
        const chatId = this.activeChatId;
        const handle = this.streamHandles.get(chatId);
        if (!handle) return;
        handle.stop(visibleChars);
        const chat = this.chats.find((c) => c.id === chatId);
        if (!chat) return;
        const last = chat.messages[chat.messages.length - 1];
        if (last && last.role === 'assistant') {
            truncateMessageTextParts(last, visibleChars);
            chat.streamingText = messageText(last);
        }
    }

    private streamForChat(chatId: string, assistantId: string): void {
        const snap = this.chats.find((c) => c.id === chatId);
        if (!snap) {
            this.streamingChatIds.delete(chatId);
            return;
        }
        const history: CourierAIMessage[] = snap.messages.slice(0, -1);

        const selectedModel = providersStore.providers
            .find((p) => p.id === snap.providerId)
            ?.models.find((m) => m.id === snap.modelId);
        const modelParams = selectedModel?.params;
        const wireTools: Record<string, string | boolean> = {};
        const modelTools = selectedModel?.tools;
        if (
            modelTools?.webSearch &&
            settingsStore.enableWebSearch &&
            snap.webSearch
        ) {
            wireTools.webSearch = modelTools.webSearch;
        }
        if (
            modelTools?.webFetch &&
            settingsStore.enableWebFetch &&
            snap.webFetch
        ) {
            wireTools.webFetch = modelTools.webFetch;
        }
        if (
            modelTools?.codeExecution &&
            settingsStore.enableCodeExecution &&
            snap.codeExecution
        ) {
            wireTools.codeExecution = modelTools.codeExecution;
        }
        const mayHaveContainerOutputs =
            snap.providerId === 'openai' && !!wireTools.codeExecution;
        const cachedChat: Chat = snap;
        const assistantRef =
            cachedChat.messages[cachedChat.messages.length - 1];
        const assembler = createMessageAssembler(assistantRef);
        cachedChat.streamingText = '';

        const finishStream = () => {
            this.streamHandles.delete(chatId);
            this.streamingChatIds.delete(chatId);
            cachedChat.streamingText = null;
        };

        const handle = sendToExtension(
            {
                chatId,
                sourceTabId: tabId,
                provider: snap.providerId,
                model: snap.modelId,
                messages: history,
                ...(snap.systemPrompt.trim()
                    ? { system: snap.systemPrompt }
                    : {}),
                params: {
                    ...(modelParams?.temperatureMax !== undefined
                        ? { temperature: snap.temperature }
                        : {}),
                    maxTokens: snap.maxTokens,
                    ...(modelParams?.thinking
                        ? {
                              thinkingLevel: snap.thinkingLevel,
                              adaptiveThinking: snap.adaptiveThinking,
                          }
                        : {}),
                    tools: wireTools,
                    tagOpenRouterRequests: settingsStore.tagOpenRouterRequests,
                    openRouterPdfEngine: settingsStore.openRouterPdfEngine,
                },
                meta: chatToMeta(snap),
                assistantMessageId: assistantId,
            },
            {
                onChunk: (chunk) => {
                    applyCourierAIChunk(assembler, chunk);
                    if (chunk.type === 'text-delta')
                        cachedChat.streamingText += chunk.delta;
                },
                onDone: () => {
                    finishStream();
                    if (mayHaveContainerOutputs) {
                        void this.refreshChatFromIDB(chatId, {
                            context: 'onDone: refresh after file capture',
                            userMessage: "Couldn't refresh chat from storage",
                        });
                    }
                },
                onError: (msg, source) => {
                    finishStream();
                    this.chatErrors = {
                        ...this.chatErrors,
                        [chatId]: formatStreamError(msg, source),
                    };
                    if (!assistantRef.parts.length) {
                        const idx = cachedChat.messages.findIndex(
                            (m) => m.id === assistantId
                        );
                        if (idx >= 0) cachedChat.messages.splice(idx, 1);
                    }
                },
            }
        );
        this.streamHandles.set(chatId, handle);
    }

    applyRemoteTurnStart(
        chatId: string,
        meta: ChatMeta,
        assistantMessageId: string
    ): void {
        const placeholder = buildAssistantPlaceholder(
            assistantMessageId,
            Date.now()
        );
        let chat = this.chats.find((c) => c.id === chatId);
        if (chat) {
            chat.messages = [
                ...chat.messages.filter((m) => m.id !== assistantMessageId),
                placeholder,
            ];
        } else {
            this.chats.unshift({
                ...meta,
                messages: [placeholder],
            });
            chat = this.chats.find((c) => c.id === chatId)!;
            const metaIdx = this.unloadedMetas.findIndex(
                (m) => m.id === chatId
            );
            if (metaIdx >= 0) this.unloadedMetas.splice(metaIdx, 1);
        }
        this.remoteStreamingChatIds.add(chatId);
        this.clearChatError(chatId);

        this.closeRemotePipeline(chatId);
        const assistantRef = chat.messages[chat.messages.length - 1];
        const assembler = createMessageAssembler(assistantRef);
        chat.streamingText = '';
        this.remotePipelines.set(chatId, {
            assembler,
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
        const history = this.storedToMessages(
            stored.messages.filter((s) => s.message.id !== assistantMessageId)
        );
        pipeline.chat.messages = [...history, assistantRef];
    }

    applyRemoteTurnChunk(chatId: string, chunk: CourierAIChunk): void {
        if (!this.remoteStreamingChatIds.has(chatId)) return;
        const pipeline = this.remotePipelines.get(chatId);
        if (!pipeline) return;
        try {
            applyCourierAIChunk(pipeline.assembler, chunk);
            if (chunk.type === 'text-delta')
                pipeline.chat.streamingText += chunk.delta;
        } catch (e) {
            log.warn('remote chunk apply failed', e);
        }
    }

    applyRemoteTurnTruncate(chatId: string, charLen: number): void {
        if (!this.remoteStreamingChatIds.has(chatId)) return;
        const pipeline = this.remotePipelines.get(chatId);
        if (!pipeline) return;
        const chat = pipeline.chat;
        const last = chat.messages[chat.messages.length - 1];
        if (!last || last.role !== 'assistant') return;
        truncateMessageTextParts(last, charLen);
        chat.streamingText = messageText(last);
    }

    private closeRemotePipeline(chatId: string): void {
        const pipeline = this.remotePipelines.get(chatId);
        if (!pipeline) return;
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
            const chat = this.chats.find((c) => c.id === chatId);
            if (chat) chat.messages = this.storedToMessages(stored.messages);
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

    async applyRemoteTurnError(chatId: string, message: string): Promise<void> {
        if (!this.remoteStreamingChatIds.has(chatId)) return;
        this.remoteStreamingChatIds.delete(chatId);
        this.closeRemotePipeline(chatId);
        this.chatErrors = {
            ...this.chatErrors,
            [chatId]: formatStreamError(message, 'api'),
        };
        await this.refreshChatFromIDB(chatId, {
            context: 'applyRemoteTurnError: loadChat failed',
            userMessage: null,
        });
    }

    async refreshActiveFromIDB(): Promise<void> {
        if (!this.activeChatId) return;
        await this.refreshChatFromIDB(this.activeChatId, {
            context: 'refreshActiveFromIDB failed',
            userMessage: "Couldn't refresh active chat",
        });
    }

    async refreshLoadedChats(chatIds: string[]): Promise<void> {
        for (const id of chatIds) {
            if (!this.chats.some((c) => c.id === id)) continue;
            await this.refreshChatFromIDB(id, {
                context: 'refreshLoadedChats: loadChat failed',
                userMessage: "Couldn't refresh chat after deleting a file",
            });
        }
    }
}

export const chatStore = new ChatStore();
