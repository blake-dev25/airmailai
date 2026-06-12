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

const LOG = '[courierai:web]';
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
        console.log(LOG, 'chat metas loaded', `${sorted.length} chats`);

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
            console.log(LOG, 'first page loaded', `${this.chats.length} chats`);
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
        console.log(
            LOG,
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
        console.log(LOG, 'entered demo mode');
    }

    search(query: string): void {
        this.searchQuery = query;
        this.highlightMessageIndex = null;
        const q = query.toLowerCase();
        const results: SearchResult[] = [];
        for (const chat of this.chats) {
            let matchIndex: number | null = null;
            let snippet = '';
            for (let i = 0; i < chat.messages.length; i++) {
                const content = messageText(chat.messages[i]);
                const idx = content.toLowerCase().indexOf(q);
                if (idx !== -1) {
                    matchIndex = i;
                    const start = Math.max(0, idx - 40);
                    const end = Math.min(content.length, idx + q.length + 60);
                    snippet =
                        (start > 0 ? '...' : '') +
                        content.slice(start, end) +
                        (end < content.length ? '...' : '');
                    break;
                }
            }
            if (matchIndex !== null) {
                results.push({
                    id: chat.id,
                    title: chat.title,
                    snippet,
                    matchIndex,
                });
            } else if (chat.title.toLowerCase().includes(q)) {
                const firstMsg = chat.messages.find(
                    (m) => messageText(m).length > 0
                );
                const firstText = firstMsg ? messageText(firstMsg) : '';
                snippet = firstText
                    ? firstText.slice(0, 100) +
                      (firstText.length > 100 ? '...' : '')
                    : '';
                results.push({
                    id: chat.id,
                    title: chat.title,
                    snippet,
                    matchIndex: null,
                });
            }
        }
        this.searchResults = results;
    }

    clearSearch(): void {
        this.searchResults = null;
        this.searchQuery = '';
        this.highlightMessageIndex = null;
    }

    searchingAll = $state(false);

    async searchAllChats(): Promise<void> {
        if (this.searchingAll || this.unloadedMetas.length === 0) return;
        this.searchingAll = true;
        try {
            const metas = this.unloadedMetas;
            const fullChats = await loadChatsByIds(metas.map((m) => m.id));
            const byId = new Map(fullChats.map((c) => [c.id, c]));
            const newChats = metas
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
            this.unloadedMetas = [];
            console.log(
                LOG,
                'loaded all chats for search',
                `${newChats.length} chats`
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
        console.log(LOG, 'resetting local chat state');
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
        console.log(LOG, 'new chat', id);
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
        console.log(LOG, 'select chat', id);
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

    remove(id: string): void {
        console.log(LOG, 'remove chat', id);
        const removedTitle =
            this.chats.find((c) => c.id === id)?.title ??
            this.unloadedMetas.find((m) => m.id === id)?.title;
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
        if (!this.demoMode)
            deleteChat(id).catch((err) => {
                reportAppError(
                    `delete chat failed (id=${id})`,
                    `Couldn't delete${removedTitle ? ` "${removedTitle}"` : ' chat'}`,
                    err
                );
            });
    }

    rename(id: string, newTitle: string): void {
        console.log(LOG, 'rename chat', id, newTitle);
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

    async export(id: string): Promise<void> {
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

        const created = new Date(chat.createdAt);
        const createdStr = created.toLocaleString();

        let md = `# ${chat.title}\nModel: ${chat.modelId}\nCreated: ${createdStr}\nExported from: CourierAI\n`;
        for (const msg of messages) {
            md += `\n### ${msg.role === 'user' ? 'User' : 'Assistant'}\n`;
            const attachments: string[] = [];
            for (const part of msg.parts) {
                if (part.type !== 'file') continue;
                attachments.push(part.filename);
            }
            if (attachments.length) {
                md += `Attachments: ${attachments.join(', ')}\n`;
            }
            md += `${messageText(msg)}\n`;
        }

        const pad = (n: number) => String(n).padStart(2, '0');
        const year = created.getFullYear();
        const month = pad(created.getMonth() + 1);
        const day = pad(created.getDate());
        const hours = pad(created.getHours());
        const mins = pad(created.getMinutes());
        const safeTitle = chat.title.replace(/[/\\:*?"<>|]/g, '-');
        const filename = `${safeTitle} - ${year}-${month}-${day} ${hours}.${mins}.md`;

        const blob = new Blob([md], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        console.log(LOG, 'exported chat', id, filename);
    }

    editMessage(index: number, content: string): void {
        if (!this.activeChatId) return;
        const chatId = this.activeChatId;
        const chat = this.chats.find((c) => c.id === chatId);
        if (!chat) return;
        const target = chat.messages[index];
        if (!target) return;
        const nonText = target.parts.filter((p) => p.type !== 'text');
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
        console.log(LOG, 'send message', {
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

        if (!this.demoMode) {
            const chat = this.chats.find((c) => c.id === chatId);
            if (chat) {
                const persistUser = () =>
                    putMessage(messageToHydrated(chatId!, userMsg))
                        .then(() =>
                            draftAttachments.length
                                ? clearDraftAttachments(chatId!)
                                : undefined
                        )
                        .catch((err) => {
                            reportAppError(
                                'persist user msg failed',
                                "Couldn't save your message",
                                err
                            );
                        });
                if (createdNewChat || draftAttachments.length) {
                    saveMeta(chatToMeta(chat))
                        .then(persistUser)
                        .catch((err) => {
                            reportAppError(
                                'persist new chat failed',
                                "Couldn't save chat",
                                err
                            );
                        });
                } else {
                    saveMeta(chatToMeta(chat)).catch((err) => {
                        reportAppError(
                            'persist meta failed',
                            "Couldn't save chat config",
                            err
                        );
                    });
                    void persistUser();
                }
            }
        }

        this.streamingChatIds.add(chatId);
        this.clearChatError(chatId);
        this.streamForChat(chatId, assistantId);
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

        if (!this.demoMode) {
            saveMeta(chatToMeta(chat)).catch((err) => {
                reportAppError(
                    'retry: meta save failed',
                    "Couldn't save chat config",
                    err
                );
            });
            deleteMessagesAfter(chatId, lastKeptMsg.id).catch((err) => {
                reportAppError(
                    'retry: truncate failed',
                    "Couldn't truncate chat history",
                    err
                );
            });
        }

        this.clearChatError(chatId);
        this.streamingChatIds.add(chatId);
        this.streamForChat(chatId, assistantId);
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
        const broadcastHistory: StoredMessage[] = history.map((m) => ({
            chatId,
            message: m,
        }));

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
                history: broadcastHistory,
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
        history: StoredMessage[],
        assistantMessageId: string
    ): void {
        const placeholder = buildAssistantPlaceholder(
            assistantMessageId,
            Date.now()
        );
        const hydratedHistory = this.storedToMessages(history);
        let chat = this.chats.find((c) => c.id === chatId);
        if (chat) {
            chat.messages = [...hydratedHistory, placeholder];
        } else {
            this.chats.unshift({
                ...meta,
                messages: [...hydratedHistory, placeholder],
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
            console.warn(LOG, 'remote chunk apply failed', e);
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
                console.error(LOG, opts.context, err);
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
