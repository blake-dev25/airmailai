import type {
    ChatMeta,
    CustomModelConfig,
    AirmailAIChunk,
    AirmailAIMessage,
    DraftAttachment,
    DraftAttachmentMeta,
    StoredChat,
    StoredMessage,
    StreamErrorSource,
} from '@airmailai/shared';
import { SvelteMap } from 'svelte/reactivity';
import { appMode } from './appMode.svelte';
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
import {
    isTurnBusy,
    isTurnRemote,
    StreamPipeline,
    type TurnState,
} from './chatTurn.svelte';
import { buildDemoChats } from './demo';
import { errorStore, reportAppError } from './errorStore.svelte';
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
    tabId,
} from './extension';
import { triggerBlobDownload } from './files';
import { providersStore } from './providersStore.svelte';
import { customModelTools } from './models/custom';
import { validateModelRequest } from './modelValidation';
import { settingsStore } from './settingsStore.svelte';
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
        customModel: chat.customModel ? { ...chat.customModel } : null,
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
    return { ...meta, messages: [], loadState: 'unloaded' };
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

type SearchState =
    | { kind: 'inactive' }
    | { kind: 'results'; query: string; results: SearchResult[] }
    | { kind: 'loading-all'; query: string; results: SearchResult[] };

function removeMessageById(chat: Chat, messageId: string): void {
    const index = chat.messages.findIndex((m) => m.id === messageId);
    if (index >= 0) chat.messages.splice(index, 1);
}

class ChatStore {
    chats = $state<Chat[]>([]);
    activeChatId = $state<string | null>(null);
    private turns = new SvelteMap<string, TurnState>();
    searchState = $state.raw<SearchState>({ kind: 'inactive' });
    highlightMessageIndex = $state<number | null>(null);
    fileStatusVersion = $state(0);
    private searchCache = new SvelteMap<string, Message[]>();
    unsearchedChatCount = $derived(
        this.chats.filter(
            (c) => c.loadState !== 'loaded' && !this.searchCache.has(c.id)
        ).length
    );
    sortedChats = $derived(
        [...this.chats].sort((a, b) => chatSortKey(b) - chatSortKey(a))
    );
    activeChat = $derived(
        this.chats.find((c) => c.id === this.activeChatId) ?? null
    );
    private activeTurn = $derived(this.turns.get(this.activeChatId ?? ''));
    isActiveChatBusy = $derived(isTurnBusy(this.activeTurn));
    canStopActive = $derived(
        this.activeTurn?.kind === 'preparing' ||
            this.activeTurn?.kind === 'local-streaming'
    );
    activeStreamError = $derived(
        this.activeTurn?.kind === 'failed' ? this.activeTurn.message : null
    );
    activeStreamingText = $derived(
        this.activeTurn?.kind === 'local-streaming' ||
            this.activeTurn?.kind === 'remote-streaming'
            ? this.activeTurn.pipeline.text
            : null
    );
    activeChatLoading = $derived(this.activeChat?.loadState === 'loading');
    activeMessages = $derived(this.activeChat?.messages ?? []);
    activeDraftAttachments = $derived(this.activeChat?.draftAttachments ?? []);
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

    isChatBusy(id: string): boolean {
        return isTurnBusy(this.turns.get(id));
    }

    chatStreamError(id: string): string | null {
        const turn = this.turns.get(id);
        return turn?.kind === 'failed' ? turn.message : null;
    }

    private endTurn(chatId: string, failure: string | null = null): void {
        const turn = this.turns.get(chatId);
        if (turn?.kind === 'local-streaming') {
            turn.handle.abort();
            turn.pipeline.flush();
        } else if (turn?.kind === 'remote-streaming') {
            turn.pipeline.flush();
        }
        if (failure === null) this.turns.delete(chatId);
        else this.turns.set(chatId, { kind: 'failed', message: failure });
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

    loadDemo(): void {
        const demoChats = buildDemoChats({
            customModel: settingsStore.customModel
                ? { ...settingsStore.customModel }
                : null,
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

    private matchAll(query: string): SearchResult[] {
        const q = query.toLowerCase();
        const results: SearchResult[] = [];
        for (const chat of this.chats) {
            const messages =
                chat.loadState === 'loaded'
                    ? chat.messages
                    : this.searchCache.get(chat.id);
            if (!messages) continue;
            const result = this.matchChat(chat.id, chat.title, messages, q);
            if (result) results.push(result);
        }
        return results;
    }

    search(query: string): void {
        this.highlightMessageIndex = null;
        this.searchState = {
            kind:
                this.searchState.kind === 'loading-all'
                    ? 'loading-all'
                    : 'results',
            query,
            results: this.matchAll(query),
        };
    }

    private refreshSearchResults(): void {
        if (this.searchState.kind === 'inactive') return;
        this.searchState = {
            ...this.searchState,
            results: this.matchAll(this.searchState.query),
        };
    }

    clearSearch(): void {
        this.searchState = { kind: 'inactive' };
        this.highlightMessageIndex = null;
        this.searchCache.clear();
    }

    async searchAllChats(): Promise<void> {
        if (this.searchState.kind !== 'results') return;
        const unsearchedIds = this.chats
            .filter(
                (c) => c.loadState !== 'loaded' && !this.searchCache.has(c.id)
            )
            .map((c) => c.id);
        if (unsearchedIds.length === 0) return;
        this.searchState = { ...this.searchState, kind: 'loading-all' };
        let fullChats: StoredChat[];
        try {
            fullChats = await loadChatsByIds(unsearchedIds);
        } catch (err) {
            if (this.searchState.kind === 'loading-all')
                this.searchState = { ...this.searchState, kind: 'results' };
            reportAppError(
                'searchAllChats failed',
                "Couldn't load all chats for search",
                err
            );
            return;
        }
        if (this.searchState.kind !== 'loading-all') return;
        const loaded = new Map(
            fullChats.map((s) => [s.id, storedToMessages(s.messages)])
        );
        for (const id of unsearchedIds) {
            this.searchCache.set(id, loaded.get(id) ?? []);
        }
        log.info('search cache built', `${fullChats.length} chats`);
        this.searchState = {
            kind: 'results',
            query: this.searchState.query,
            results: this.matchAll(this.searchState.query),
        };
    }

    resetLocal(): void {
        log.info('resetting local chat state');
        for (const chatId of [...this.turns.keys()]) this.endTurn(chatId);
        this.chats = [];
        this.activeChatId = null;
        this.clearSearch();
        clearFileBlobCache();
        settingsStore.systemPrompt = '';
        settingsStore.applyToolDefaults(providersStore.selectedModel);
    }

    clearChatError(id: string): void {
        if (this.turns.get(id)?.kind === 'failed') this.turns.delete(id);
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
            loadState: 'loaded',
            createdAt: now,
            ...settingsStore.snapshotChatConfig(),
        });
        this.activeChatId = id;
    }

    async activate(id: string, matchIndex?: number | null): Promise<void> {
        this.highlightMessageIndex = matchIndex ?? null;
        log.info('select chat', id);
        this.activeChatId = id;
        errorStore.clearAppWarning();
        const chat = this.findChat(id);
        if (!chat) return;
        settingsStore.applyChatConfig(chat);
        settingsStore.reconcileModelSelection(providersStore.providers);
        if (chat.loadState !== 'unloaded' || appMode.isDemo) return;
        chat.loadState = 'loading';
        let stored: StoredChat | null = null;
        try {
            stored = await loadChat(id);
        } catch (err) {
            reportAppError(
                `activate: loadChat failed (id=${id})`,
                "Couldn't load chat",
                err
            );
        }
        if (chat.loadState !== 'loading') return;
        if (!stored || this.isChatBusy(id)) {
            chat.loadState = 'unloaded';
            return;
        }
        chat.messages = storedToMessages(stored.messages);
        chat.revision = stored.revision;
        chat.loadState = 'loaded';
    }

    private removeLocal(id: string): void {
        this.endTurn(id);
        const chatIdx = this.chats.findIndex((c) => c.id === id);
        if (chatIdx >= 0) this.chats.splice(chatIdx, 1);
        if (this.activeChatId === id) {
            this.activeChatId = null;
            settingsStore.systemPrompt = '';
            settingsStore.applyToolDefaults(providersStore.selectedModel);
        }
    }

    remove(id: string): void {
        log.info('remove chat', id);
        const removedTitle = this.findChat(id)?.title;
        this.removeLocal(id);
        if (!appMode.isDemo)
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
            if (chat.loadState === 'loaded') chat.revision = revision;
            return;
        }
        this.chats.unshift(chatFromMeta(meta));
    }

    applyRemoteChatsImported(metas: ChatMeta[]): void {
        for (const meta of metas) {
            this.searchCache.delete(meta.id);
            const chat = this.findChat(meta.id);
            if (chat?.loadState === 'loaded') {
                void this.refreshChatFromIDB(meta.id, {
                    context: 'chats-imported: reload failed',
                    userMessage: "Couldn't refresh an imported chat",
                });
            }
            this.applyRemoteMetaChanged(meta);
        }
    }

    async applyMessageChanged(
        chatId: string,
        messageId: string,
        revision: number
    ): Promise<void> {
        this.searchCache.delete(chatId);
        const chat = this.findChat(chatId);
        if (chat?.loadState !== 'loaded' || this.isChatBusy(chatId)) return;
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
                this.isChatBusy(chatId) ||
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
            this.refreshSearchResults();
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
        if (!appMode.isDemo)
            saveMeta(chatToMeta(chat)).catch((err) => {
                reportAppError(
                    `rename save failed (id=${id})`,
                    "Couldn't rename chat",
                    err
                );
            });
    }

    private transferInfo(meta: TransferChatInfo): TransferChatInfo {
        return {
            customModel: meta.customModel ? { ...meta.customModel } : null,
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
        if (chat.loadState !== 'loaded') {
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
        model: string | null,
        custom: boolean
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
        if (!custom && !provider.models.some((m) => m.id === modelId))
            return null;
        return { providerId, modelId };
    }

    private buildImportedChat(imp: ImportedChat): Chat {
        const createdAt = imp.createdAt || Date.now();
        const resolved = this.resolveImportedModel(
            imp.model,
            !!imp.customModel
        );
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
            loadState: 'loaded',
            createdAt,
            lastMessageAt: messages.length
                ? messages[messages.length - 1].metadata.createdAt
                : createdAt,
            ...settingsStore.snapshotChatConfig(),
            ...(resolved
                ? {
                      ...resolved,
                      customModel: imp.customModel
                          ? { ...imp.customModel }
                          : null,
                  }
                : {}),
            systemPrompt: imp.systemPrompt,
        };
    }

    private async persistImportedChats(chats: Chat[]): Promise<Chat[]> {
        if (appMode.isDemo) return chats;
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
        if (!appMode.isDemo) {
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
        if (removedId && !appMode.isDemo)
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
        if (!appMode.isDemo) {
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
            loadState: 'loaded',
            createdAt: Date.now(),
            ...settingsStore.snapshotChatConfig(),
        };
        this.chats.unshift(chat);
        this.activeChatId = chatId;
        if (!appMode.isDemo) await saveMeta(chatToMeta(chat));
        return chatId;
    }

    async prepareAttachmentUpload(): Promise<string> {
        const chatId = await this.ensureActiveChat();
        const chat = this.findChat(chatId);
        if (!chat) throw new Error('The destination chat was deleted.');
        if (!appMode.isDemo) await saveMeta(chatToMeta(chat));
        return chatId;
    }

    async addDraftAttachment(
        chatId: string,
        replicateTo: string | undefined,
        attachment: DraftAttachmentMeta,
        file: File,
        onProgress?: (progress: number) => void
    ): Promise<{ chatId: string; attachment: DraftAttachment } | null> {
        if (appMode.isDemo) return null;
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
        if (!appMode.isDemo) await reqRemoveDraftAttachment(chatId, key);
    }

    async clearActiveDraftAttachments(): Promise<void> {
        const chat = this.activeChat;
        if (!chat) return;
        chat.draftAttachments = [];
        if (!appMode.isDemo) await clearDraftAttachments(chat.id);
    }

    private validateModelConfig(
        config: {
            providerId: string;
            modelId: string;
            customModel: CustomModelConfig | null;
        } = settingsStore
    ): boolean {
        try {
            validateModelRequest(
                config.providerId,
                config.modelId,
                config.customModel
            );
            return true;
        } catch (err) {
            reportAppError(
                'invalid model configuration',
                "Couldn't send message",
                err
            );
            return false;
        }
    }

    private finishPreparing(chatId: string, assistantId: string): boolean {
        const turn = this.turns.get(chatId);
        if (turn?.kind !== 'preparing') return false;
        if (!turn.stopRequested) return true;
        this.turns.delete(chatId);
        const chat = this.findChat(chatId);
        if (chat) removeMessageById(chat, assistantId);
        log.info('turn stopped before streaming', chatId);
        return false;
    }

    async sendMessage(content: string): Promise<boolean> {
        if (this.activeChatId && this.isChatBusy(this.activeChatId))
            return false;

        if (!this.validateModelConfig()) return false;

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
                loadState: 'loaded',
                createdAt: Date.now(),
                ...settingsStore.snapshotChatConfig(),
            });
            this.activeChatId = chatId;
        } else {
            const existing = this.findChat(chatId);
            if (!existing || existing.loadState !== 'loaded') {
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

        this.turns.set(chatId, { kind: 'preparing', stopRequested: false });

        if (appMode.isDemo) {
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
            if (this.turns.get(id)?.kind === 'preparing') this.turns.delete(id);
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
        if (this.finishPreparing(id, assistantId))
            this.streamForChat(id, assistantId);
        return true;
    }

    async retry(index: number): Promise<void> {
        const chat = this.activeChat;
        if (!chat) return;
        const chatId = chat.id;
        if (this.isChatBusy(chatId)) return;
        if (!this.validateModelConfig()) return;
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

        this.turns.set(chatId, { kind: 'preparing', stopRequested: false });

        if (appMode.isDemo) {
            this.streamForChat(chatId, assistantId);
            return;
        }

        try {
            chat.revision = await prepareRetry(
                chatToMeta(chat),
                lastKeptMsg.id
            );
        } catch (err) {
            if (this.turns.get(chatId)?.kind === 'preparing')
                this.turns.delete(chatId);
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
        if (this.finishPreparing(chatId, assistantId))
            this.streamForChat(chatId, assistantId);
    }

    stop(visibleChars: number): void {
        const chatId = this.activeChatId;
        if (!chatId) return;
        const turn = this.turns.get(chatId);
        if (turn?.kind === 'preparing') {
            this.turns.set(chatId, { kind: 'preparing', stopRequested: true });
            return;
        }
        if (turn?.kind !== 'local-streaming') return;
        turn.handle.stop(visibleChars);
        turn.pipeline.truncate(visibleChars);
    }

    private streamForChat(chatId: string, assistantId: string): void {
        const chat = this.findChat(chatId);
        if (!chat) {
            this.turns.delete(chatId);
            return;
        }
        if (!this.validateModelConfig(chat)) {
            this.turns.delete(chatId);
            removeMessageById(chat, assistantId);
            return;
        }

        const selectedModel = providersStore.providers
            .find((p) => p.id === chat.providerId)
            ?.models.find((m) => m.id === chat.modelId);
        const modelParams = selectedModel?.params;
        const wireTools: Record<string, string | boolean> = {};
        const modelTools = chat.customModel
            ? customModelTools(chat.providerId, chat.customModel)
            : selectedModel?.tools;
        const toolConfig = chat.customModel ?? chat;
        if (
            modelTools?.webSearch &&
            settingsStore.enableWebSearch &&
            toolConfig.webSearch
        ) {
            wireTools.webSearch = modelTools.webSearch;
        }
        if (
            modelTools?.webFetch &&
            settingsStore.enableWebFetch &&
            toolConfig.webFetch
        ) {
            wireTools.webFetch = modelTools.webFetch;
        }
        if (
            modelTools?.codeExecution &&
            settingsStore.enableCodeExecution &&
            toolConfig.codeExecution
        ) {
            wireTools.codeExecution = modelTools.codeExecution;
        }
        const mayHaveContainerOutputs =
            chat.providerId === 'openai' && !!wireTools.codeExecution;
        const assistantRef = chat.messages[chat.messages.length - 1];
        const pipeline = new StreamPipeline(chat, assistantRef);
        const isCurrentTurn = () => {
            const turn = this.turns.get(chatId);
            return (
                turn?.kind === 'local-streaming' && turn.pipeline === pipeline
            );
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
                    ...(chat.customModel
                        ? { customModel: { ...chat.customModel } }
                        : {
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
                          }),
                    tools: wireTools,
                    tagOpenRouterRequests: settingsStore.tagOpenRouterRequests,
                    openRouterPdfEngine: settingsStore.openRouterPdfEngine,
                },
                meta: chatToMeta(chat),
                assistantMessageId: assistantId,
                assistantCreatedAt: assistantRef.metadata.createdAt,
            },
            {
                onChunk: (chunk) => {
                    if (isCurrentTurn()) pipeline.push(chunk);
                },
                onDone: (revision) => {
                    if (!isCurrentTurn()) return;
                    chat.revision = revision;
                    this.endTurn(chatId);
                    versionCheck.maybeCheckWebVersion();
                    if (mayHaveContainerOutputs) {
                        void this.refreshChatFromIDB(chatId, {
                            context: 'onDone: refresh after file capture',
                            userMessage: "Couldn't refresh chat from storage",
                        });
                    }
                },
                onError: (msg, source, revision) => {
                    if (!isCurrentTurn()) return;
                    if (revision !== undefined) chat.revision = revision;
                    this.endTurn(chatId, formatStreamError(msg, source));
                    versionCheck.maybeCheckWebVersion();
                    if (!assistantRef.parts.length)
                        removeMessageById(chat, assistantId);
                },
            }
        );
        this.turns.set(chatId, { kind: 'local-streaming', handle, pipeline });
    }

    applyRemoteTurnStart(
        chatId: string,
        meta: ChatMeta,
        assistantMessageId: string,
        assistantCreatedAt: number
    ): void {
        const current = this.turns.get(chatId);
        if (
            current?.kind === 'preparing' ||
            current?.kind === 'local-streaming'
        ) {
            log.warn('remote turn-start ignored, local turn active', chatId);
            return;
        }
        this.endTurn(chatId);
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
                loadState: 'unloaded',
            });
            chat = this.findChat(chatId)!;
        }
        const assistantRef = chat.messages[chat.messages.length - 1];
        this.turns.set(chatId, {
            kind: 'remote-streaming',
            pipeline: new StreamPipeline(chat, assistantRef),
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
        const turn = this.turns.get(chatId);
        if (
            turn?.kind !== 'remote-streaming' ||
            turn.pipeline.message.id !== assistantMessageId
        )
            return;
        const { chat, message } = turn.pipeline;
        const history = storedToMessages(
            stored.messages.filter((s) => s.message.id !== assistantMessageId)
        );
        chat.messages = [...history, message];
        chat.revision = stored.revision;
        chat.loadState = 'loaded';
    }

    applyRemoteTurnChunk(chatId: string, chunk: AirmailAIChunk): void {
        const turn = this.turns.get(chatId);
        if (turn?.kind !== 'remote-streaming') return;
        try {
            turn.pipeline.push(chunk);
        } catch (e) {
            log.warn('remote chunk apply failed', e);
        }
    }

    applyRemoteTurnTruncate(chatId: string, charLen: number): void {
        const turn = this.turns.get(chatId);
        if (turn?.kind !== 'remote-streaming') return;
        turn.pipeline.truncate(charLen);
    }

    private endRemoteTurn(
        chatId: string,
        failure: string | null = null
    ): boolean {
        if (!isTurnRemote(this.turns.get(chatId))) return false;
        this.endTurn(chatId, failure);
        return true;
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
                !this.isChatBusy(chatId) &&
                stored.revision >= (chat.revision ?? 0)
            ) {
                chat.messages = storedToMessages(stored.messages);
                chat.revision = stored.revision;
                chat.loadState = 'loaded';
            }
        } else if (opts.onMissing === 'drop') {
            const idx = this.chats.findIndex((c) => c.id === chatId);
            if (idx >= 0) this.chats.splice(idx, 1);
            if (this.activeChatId === chatId) this.activeChatId = null;
        }
    }

    async applyRemoteTurnDone(chatId: string): Promise<void> {
        if (!this.endRemoteTurn(chatId)) return;
        await this.refreshChatFromIDB(chatId, {
            context: 'applyRemoteTurnDone: loadChat failed',
            userMessage: "Couldn't refresh chat from storage",
        });
    }

    async applyRemoteTurnAborted(chatId: string): Promise<void> {
        if (!this.endRemoteTurn(chatId)) return;
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
        if (!this.endRemoteTurn(chatId, formatStreamError(message, source)))
            return;
        await this.refreshChatFromIDB(chatId, {
            context: 'applyRemoteTurnError: loadChat failed',
            userMessage: null,
        });
    }

    syncActiveTurns(activeChatIds: string[]): string[] {
        if (appMode.isDemo) return [];
        const active = new Set(activeChatIds);
        const interrupted: string[] = [];
        for (const [id, turn] of [...this.turns]) {
            if (!isTurnRemote(turn) || active.has(id)) continue;
            this.endTurn(id);
            interrupted.push(id);
        }
        for (const id of active) {
            const turn = this.turns.get(id);
            if (turn === undefined || turn.kind === 'failed')
                this.turns.set(id, { kind: 'remote-joined-midway' });
        }
        return interrupted;
    }

    async reconcileFromIDB(activeChatIds: string[]): Promise<void> {
        if (appMode.isDemo) return;
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
            const busy = this.isChatBusy(chat.id);
            const loaded = chat.loadState === 'loaded';
            const fresh = metaById.get(chat.id);
            if (fresh) {
                if (
                    !busy &&
                    loaded &&
                    (fresh.revision ?? 0) !== (chat.revision ?? 0) &&
                    !staleIds.includes(chat.id)
                ) {
                    staleIds.push(chat.id);
                }
                const revision = chat.revision;
                Object.assign(chat, fresh);
                if (loaded) chat.revision = revision;
            } else if (!busy && (!loaded || chat.messages.length > 0)) {
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
                    !this.isChatBusy(chat.id) &&
                    stored.revision >= (chat.revision ?? 0)
                ) {
                    chat.messages = storedToMessages(stored.messages);
                    chat.revision = stored.revision;
                    chat.loadState = 'loaded';
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
            if (this.findChat(id)?.loadState !== 'loaded') continue;
            await this.refreshChatFromIDB(id, {
                context: 'refreshLoadedChats: loadChat failed',
                userMessage: "Couldn't refresh chat after deleting a file",
            });
        }
    }
}

export const chatStore = new ChatStore();
