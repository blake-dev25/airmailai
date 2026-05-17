import type {
    Attachment,
    AttachmentRef,
    ChatMessage,
    ChatMeta,
    HydratedStoredMessage,
    StoredChat,
    StoredMessage,
    StreamErrorSource,
    ToolResult,
} from '@courier/shared';
import { buildDemoChats } from './demo';
import { errorStore, formatErr } from './errorStore.svelte';
import {
    deleteChat,
    deleteMessage,
    deleteMessagesAfter,
    loadChat,
    loadChatMetas,
    loadChatsByIds,
    putMessage,
    saveMeta,
    sendToExtension,
    type StreamHandle,
    tabId,
} from './extension';
import { providersStore } from './providersStore.svelte';
import { settingsStore } from './settingsStore.svelte';
import type { Chat, Message, SearchResult } from './types';

const LOG = '[courier:web]';
const INITIAL_PAGE_SIZE = 40;
const LOAD_MORE_PAGE_SIZE = 15;

function formatStreamError(
    message: string,
    source: StreamErrorSource = 'api'
): string {
    return `${source === 'extension' ? 'Ext' : 'API'} Error: ${message}`;
}

// Persisted messages already carry id + createdAt — the Message type is a
// 1:1 client mirror. Strip the chatId (it's already implied by the
// containing chat).
function hydrateStoredMessages(stored: StoredMessage[]): Message[] {
    return stored.map(
        ({
            id,
            createdAt,
            role,
            content,
            thinking,
            attachments,
            toolResults,
            tokens,
        }) => ({
            id,
            createdAt,
            role,
            content,
            ...(thinking ? { thinking } : {}),
            ...(attachments ? { attachments } : {}),
            ...(toolResults ? { toolResults } : {}),
            ...(tokens ? { tokens } : {}),
        })
    );
}

// Build the wire-shape persistence record for a single message, inlining
// any fresh upload bytes the chat is still carrying so the ext can store
// them in one transaction with the message row.
function messageToHydrated(
    chatId: string,
    msg: Message,
    pendingBlobs?: Map<string, Attachment>
): HydratedStoredMessage {
    const attachments = msg.attachments?.map((ref) => {
        const fresh = pendingBlobs?.get(ref.hash);
        return fresh ?? ref;
    });
    return {
        chatId,
        id: msg.id,
        createdAt: msg.createdAt,
        role: msg.role,
        content: msg.content,
        ...(msg.thinking ? { thinking: msg.thinking } : {}),
        ...(attachments?.length ? { attachments } : {}),
        ...(msg.toolResults?.length ? { toolResults: msg.toolResults } : {}),
        ...(msg.tokens ? { tokens: msg.tokens } : {}),
    };
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
        systemPrompt: chat.systemPrompt,
    };
}

class ChatStore {
    chats = $state<Chat[]>([]);
    // Metas for chats not yet loaded into `chats` (older pages). Sorted newest-first.
    unloadedMetas = $state<ChatMeta[]>([]);
    activeChatId = $state<string | null>(null);
    streamingChatIds = $state<string[]>([]);
    // Chats currently streaming in *other* tabs. Populated from broadcast
    // turn-start events; subsequent chunks/done/error/aborted only apply if
    // the chatId is in this set.
    remoteStreamingChatIds = $state<string[]>([]);
    chatErrors = $state<Record<string, string>>({});
    searchResults = $state<SearchResult[] | null>(null);
    searchQuery = $state('');
    highlightMessageIndex = $state<number | null>(null);
    chatLoading = $state(false);
    isLoadingMore = $state(false);

    // Demo mode is owned here because it gates chat persistence. Set by
    // appLifecycle when the user picks "look around" without an extension.
    demoMode = $state(false);

    // Handles for active streams — abort() hard-cancels (no save), stop()
    // gracefully halts and saves with truncated visible content.
    private streamHandles = new Map<string, StreamHandle>();

    hasMoreChats = $derived(this.unloadedMetas.length > 0);
    isActiveLocalStreaming = $derived(
        this.streamingChatIds.includes(this.activeChatId ?? '')
    );
    isActiveRemoteStreaming = $derived(
        this.remoteStreamingChatIds.includes(this.activeChatId ?? '')
    );
    isActiveStreaming = $derived(
        this.isActiveLocalStreaming || this.isActiveRemoteStreaming
    );
    // Sidebar gets the union — any chat being streamed by any tab gets the spinner.
    allStreamingChatIds = $derived([
        ...this.streamingChatIds,
        ...this.remoteStreamingChatIds,
    ]);
    activeStreamError = $derived(
        this.chatErrors[this.activeChatId ?? ''] ?? null
    );
    activeMessages = $derived(
        this.chats.find((c) => c.id === this.activeChatId)?.messages ?? []
    );
    // Tokens live on the assistant message that produced them — surface the
    // most recent assistant turn's usage for the footer/header indicators.
    activeTokens = $derived.by(() => {
        const msgs =
            this.chats.find((c) => c.id === this.activeChatId)?.messages ?? [];
        for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === 'assistant' && msgs[i].tokens) {
                return msgs[i].tokens!;
            }
        }
        return null;
    });

    // --- Initial load + pagination ---

    async loadInitialPage(): Promise<void> {
        let metas: ChatMeta[];
        try {
            metas = await loadChatMetas();
        } catch (err) {
            console.error(LOG, 'loadInitialPage: metas failed', err);
            errorStore.setAppError(
                `Couldn't load chat list: ${formatErr(err)}`
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
                console.error(LOG, 'loadInitialPage: chats failed', err);
                errorStore.setAppError(
                    `Couldn't load chat history: ${formatErr(err)}`
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
                        messages: hydrateStoredMessages(stored.messages),
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
            console.error(LOG, 'loadMore failed', err);
            errorStore.setAppError(
                `Couldn't load more chats: ${formatErr(err)}`
            );
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
                    messages: hydrateStoredMessages(stored.messages),
                };
            })
            .filter((c): c is Chat => c !== null);
        this.chats = [...this.chats, ...newChats];
        this.unloadedMetas = this.unloadedMetas.slice(LOAD_MORE_PAGE_SIZE);
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
        });
        this.chats = demoChats;
        this.unloadedMetas = [];
        this.activeChatId = demoChats[0].id;
        this.demoMode = true;
        console.log(LOG, 'entered demo mode');
    }

    // --- Search ---

    search(query: string): void {
        this.searchQuery = query;
        this.highlightMessageIndex = null;
        const q = query.toLowerCase();
        const results: SearchResult[] = [];
        for (const chat of this.chats) {
            let matchIndex: number | null = null;
            let snippet = '';
            for (let i = 0; i < chat.messages.length; i++) {
                const content = chat.messages[i].content;
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
                const firstMsg = chat.messages.find((m) => m.content);
                snippet = firstMsg
                    ? firstMsg.content.slice(0, 100) +
                      (firstMsg.content.length > 100 ? '...' : '')
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

    // --- Error helpers ---

    clearChatError(id: string): void {
        if (!this.chatErrors[id]) return;
        const { [id]: _, ...rest } = this.chatErrors;
        this.chatErrors = rest;
    }

    clearActiveChatError(): void {
        if (!this.activeChatId) return;
        this.clearChatError(this.activeChatId);
    }

    // --- Chat CRUD ---

    newChat(): void {
        const id = crypto.randomUUID();
        const now = Date.now();
        console.log(LOG, 'new chat', id);
        this.chats = [
            {
                id,
                title: 'New Chat',
                messages: [],
                createdAt: now,
                systemPrompt: settingsStore.systemPrompt,
                providerId: settingsStore.providerId,
                modelId: settingsStore.modelId,
                temperature: settingsStore.temperature,
                maxTokens: settingsStore.maxTokens,
                thinkingLevel: settingsStore.thinkingLevel,
                adaptiveThinking: settingsStore.adaptiveThinking,
                webSearch: settingsStore.webSearch,
            },
            ...this.chats,
        ];
        this.activeChatId = id;
    }

    async activate(id: string, matchIndex?: number | null): Promise<void> {
        this.highlightMessageIndex = matchIndex ?? null;
        console.log(LOG, 'select chat', id);
        this.activeChatId = id;

        // Restore model config + system prompt from whichever side has the meta.
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
            console.error(LOG, 'activate: loadChat failed', id, err);
            errorStore.setAppError(`Couldn't load chat: ${formatErr(err)}`);
            this.chatLoading = false;
            return;
        }
        this.chatLoading = false;

        if (full && this.activeChatId === id) {
            this.chats = [
                ...this.chats,
                {
                    ...meta,
                    messages: hydrateStoredMessages(full.messages),
                },
            ];
            this.unloadedMetas = this.unloadedMetas.filter((m) => m.id !== id);
        }
    }

    remove(id: string): void {
        console.log(LOG, 'remove chat', id);
        const removedTitle =
            this.chats.find((c) => c.id === id)?.title ??
            this.unloadedMetas.find((m) => m.id === id)?.title;
        this.streamHandles.get(id)?.abort();
        this.streamHandles.delete(id);
        this.chats = this.chats.filter((c) => c.id !== id);
        this.unloadedMetas = this.unloadedMetas.filter((t) => t.id !== id);
        if (this.activeChatId === id) {
            this.activeChatId = null;
            settingsStore.systemPrompt = '';
        }
        this.streamingChatIds = this.streamingChatIds.filter(
            (sid) => sid !== id
        );
        this.clearChatError(id);
        if (!this.demoMode)
            deleteChat(id).catch((err) => {
                console.error(LOG, 'delete chat failed', id, err);
                errorStore.setAppError(
                    `Couldn't delete${removedTitle ? ` "${removedTitle}"` : ' chat'}: ${formatErr(err)}`
                );
            });
    }

    rename(id: string, newTitle: string): void {
        console.log(LOG, 'rename chat', id, newTitle);
        this.chats = this.chats.map((c) =>
            c.id === id ? { ...c, title: newTitle } : c
        );
        this.unloadedMetas = this.unloadedMetas.map((m) =>
            m.id === id ? { ...m, title: newTitle } : m
        );
        const updated = this.chats.find((c) => c.id === id);
        if (updated && !this.demoMode)
            saveMeta(chatToMeta(updated)).catch((err) => {
                console.error(LOG, 'rename save failed', id, err);
                errorStore.setAppError(
                    `Couldn't rename chat: ${formatErr(err)}`
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
                if (full) messages = hydrateStoredMessages(full.messages);
            } catch (err) {
                console.error(LOG, 'export: loadChat failed', id, err);
                errorStore.setAppError(
                    `Couldn't load chat for export: ${formatErr(err)}`
                );
                return;
            }
        }

        const created = new Date(chat.createdAt);
        const createdStr = created.toLocaleString();

        let md = `# ${chat.title}\nModel: ${chat.modelId}\nCreated: ${createdStr}\nExported from: CourierAI\n`;
        for (const msg of messages) {
            md += `\n### ${msg.role === 'user' ? 'User' : 'Assistant'}\n`;
            if (msg.attachments?.length) {
                md += `Attachments: ${msg.attachments.map((a) => a.name).join(', ')}\n`;
            }
            md += `${msg.content}\n`;
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
        let editedMsg: Message | undefined;
        this.chats = this.chats.map((c) => {
            if (c.id !== chatId) return c;
            const msgs = [...c.messages];
            msgs[index] = { ...msgs[index], content };
            editedMsg = msgs[index];
            return { ...c, messages: msgs };
        });
        if (editedMsg && !this.demoMode) {
            const chat = this.chats.find((c) => c.id === chatId);
            putMessage(
                chatId,
                messageToHydrated(chatId, editedMsg, chat?.pendingBlobs)
            ).catch((err) => {
                console.error(LOG, 'edit save failed', chatId, err);
                errorStore.setAppError(
                    `Couldn't save edited message: ${formatErr(err)}`
                );
            });
        }
    }

    deleteMessage(index: number): void {
        if (!this.activeChatId) return;
        const chatId = this.activeChatId;
        const chat = this.chats.find((c) => c.id === chatId);
        const removedId = chat?.messages[index]?.id;
        this.chats = this.chats.map((c) => {
            if (c.id !== chatId) return c;
            return { ...c, messages: c.messages.filter((_, i) => i !== index) };
        });
        if (removedId && !this.demoMode)
            deleteMessage(chatId, removedId).catch((err) => {
                console.error(LOG, 'delete-msg save failed', chatId, err);
                errorStore.setAppError(
                    `Couldn't delete message: ${formatErr(err)}`
                );
            });
    }

    // --- Streaming ---

    sendMessage(content: string, attachments?: Attachment[]): void {
        if (
            this.activeChatId &&
            this.streamingChatIds.includes(this.activeChatId)
        )
            return;
        console.log(LOG, 'send message', {
            provider: settingsStore.providerId,
            model: settingsStore.modelId,
            contentLength: content.length,
            attachmentCount: attachments?.length ?? 0,
            existingChat: this.activeChatId,
        });

        // Auto-create a chat on first message
        let chatId = this.activeChatId;
        let createdNewChat = false;
        if (!chatId) {
            chatId = crypto.randomUUID();
            createdNewChat = true;
            const now = Date.now();
            const title = content.slice(0, 40);
            this.chats = [
                {
                    id: chatId,
                    title,
                    messages: [],
                    createdAt: now,
                    systemPrompt: settingsStore.systemPrompt,
                    providerId: settingsStore.providerId,
                    modelId: settingsStore.modelId,
                    temperature: settingsStore.temperature,
                    maxTokens: settingsStore.maxTokens,
                    thinkingLevel: settingsStore.thinkingLevel,
                    adaptiveThinking: settingsStore.adaptiveThinking,
                    webSearch: settingsStore.webSearch,
                },
                ...this.chats,
            ];
            this.activeChatId = chatId;
        } else {
            // Update config and rename if this is the first message
            const isFirst =
                (this.chats.find((c) => c.id === chatId)?.messages.length ??
                    0) === 0;
            this.chats = this.chats.map((c) => {
                if (c.id !== chatId) return c;
                return {
                    ...c,
                    systemPrompt: settingsStore.systemPrompt,
                    providerId: settingsStore.providerId,
                    modelId: settingsStore.modelId,
                    temperature: settingsStore.temperature,
                    maxTokens: settingsStore.maxTokens,
                    thinkingLevel: settingsStore.thinkingLevel,
                    adaptiveThinking: settingsStore.adaptiveThinking,
                    webSearch: settingsStore.webSearch,
                    ...(isFirst ? { title: content.slice(0, 40) } : {}),
                };
            });
        }

        const refs: AttachmentRef[] | undefined = attachments?.length
            ? attachments.map(({ hash, name, mediaType, sizeBytes }) => ({
                  hash,
                  name,
                  mediaType,
                  sizeBytes,
              }))
            : undefined;
        const userMsg: Message = {
            id: crypto.randomUUID(),
            createdAt: Date.now(),
            role: 'user',
            content,
            ...(refs ? { attachments: refs } : {}),
        };
        // Pre-allocate the assistant message id so streamForChat can hand
        // the same id to the ext's terminal save — the row that lands in
        // IDB matches the placeholder we're rendering against.
        const assistantPlaceholder: Message = {
            id: crypto.randomUUID(),
            createdAt: Date.now(),
            role: 'assistant',
            content: '',
        };
        this.chats = this.chats.map((c) => {
            if (c.id !== chatId) return c;
            const nextPending = attachments?.length
                ? new Map(c.pendingBlobs ?? [])
                : c.pendingBlobs;
            if (attachments?.length && nextPending) {
                for (const att of attachments) nextPending.set(att.hash, att);
            }
            return {
                ...c,
                messages: [...c.messages, userMsg, assistantPlaceholder],
                ...(nextPending ? { pendingBlobs: nextPending } : {}),
            };
        });

        // Persist meta first if brand new chat, then the user message. Both
        // are fire-and-forget so we don't block stream startup; the ext's
        // put_message refuses to write a message under a missing meta row,
        // so we await meta before the message to avoid that drop. Errors
        // surface as a toast.
        if (!this.demoMode) {
            const chat = this.chats.find((c) => c.id === chatId);
            if (chat) {
                const persistUser = () =>
                    putMessage(
                        chatId!,
                        messageToHydrated(chatId!, userMsg, chat.pendingBlobs)
                    ).catch((err) => {
                        console.error(LOG, 'persist user msg failed', err);
                        errorStore.setAppError(
                            `Couldn't save your message: ${formatErr(err)}`
                        );
                    });
                if (createdNewChat) {
                    saveMeta(chatToMeta(chat))
                        .then(persistUser)
                        .catch((err) => {
                            console.error(LOG, 'persist new chat failed', err);
                            errorStore.setAppError(
                                `Couldn't save chat: ${formatErr(err)}`
                            );
                        });
                } else {
                    // Existing chats whose config changed (provider/model/
                    // etc.) get meta re-saved too — fire-and-forget alongside
                    // the user-message put.
                    saveMeta(chatToMeta(chat)).catch((err) => {
                        console.error(LOG, 'persist meta failed', err);
                        errorStore.setAppError(
                            `Couldn't save chat config: ${formatErr(err)}`
                        );
                    });
                    void persistUser();
                }
            }
        }

        this.streamingChatIds = [...this.streamingChatIds, chatId];
        this.clearChatError(chatId);
        this.streamForChat(chatId, assistantPlaceholder.id);
    }

    retry(index: number): void {
        if (!this.activeChatId) return;
        const chatId = this.activeChatId;
        const chat = this.chats.find((c) => c.id === chatId);
        if (!chat) return;

        // Abort any in-progress stream for this chat
        this.streamHandles.get(chatId)?.abort();
        this.streamHandles.delete(chatId);
        this.streamingChatIds = this.streamingChatIds.filter(
            (id) => id !== chatId
        );

        // If assistant message, treat as retrying the user message above it
        const msg = chat.messages[index];
        if (!msg) return;
        const keepUpTo = msg.role === 'user' ? index : index - 1;
        if (keepUpTo < 0) return;

        const lastKeptMsg = chat.messages[keepUpTo];
        const assistantPlaceholder: Message = {
            id: crypto.randomUUID(),
            createdAt: Date.now(),
            role: 'assistant',
            content: '',
        };

        this.chats = this.chats.map((c) =>
            c.id === chatId
                ? {
                      ...c,
                      systemPrompt: settingsStore.systemPrompt,
                      providerId: settingsStore.providerId,
                      modelId: settingsStore.modelId,
                      temperature: settingsStore.temperature,
                      maxTokens: settingsStore.maxTokens,
                      thinkingLevel: settingsStore.thinkingLevel,
                      adaptiveThinking: settingsStore.adaptiveThinking,
                      webSearch: settingsStore.webSearch,
                      messages: [
                          ...c.messages.slice(0, keepUpTo + 1),
                          assistantPlaceholder,
                      ],
                  }
                : c
        );

        // Truncate IDB to match: drop every persisted message after the one
        // we're retrying. Config changes also get persisted so the next
        // turn uses the freshly-selected provider/model on reload.
        if (!this.demoMode) {
            const updated = this.chats.find((c) => c.id === chatId);
            if (updated) {
                saveMeta(chatToMeta(updated)).catch((err) => {
                    console.error(LOG, 'retry: meta save failed', err);
                    errorStore.setAppError(
                        `Couldn't save chat config: ${formatErr(err)}`
                    );
                });
            }
            deleteMessagesAfter(chatId, lastKeptMsg.id).catch((err) => {
                console.error(LOG, 'retry: truncate failed', err);
                errorStore.setAppError(
                    `Couldn't truncate chat history: ${formatErr(err)}`
                );
            });
        }

        this.clearChatError(chatId);
        this.streamingChatIds = [...this.streamingChatIds, chatId];
        this.streamForChat(chatId, assistantPlaceholder.id);
    }

    // Graceful stop. ChatPanel passes the currently-visible (smoothed) text so
    // we save exactly what the user saw — any queued-but-not-drained characters
    // are discarded. Empty stop discards the assistant turn entirely.
    stop(truncated: string): void {
        if (!this.activeChatId) return;
        const chatId = this.activeChatId;
        const handle = this.streamHandles.get(chatId);
        if (!handle) return;

        handle.stop(truncated);
        this.streamHandles.delete(chatId);
        this.streamingChatIds = this.streamingChatIds.filter(
            (id) => id !== chatId
        );

        this.chats = this.chats.map((c) => {
            if (c.id !== chatId) return c;
            if (truncated === '') {
                return { ...c, messages: c.messages.slice(0, -1) };
            }
            const msgs = [...c.messages];
            msgs[msgs.length - 1] = {
                ...msgs[msgs.length - 1],
                content: truncated,
            };
            return { ...c, messages: msgs };
        });
    }

    // Streams an assistant response into the trailing placeholder of `chatId`.
    // Caller is responsible for prepping the chat: messages must end with an
    // empty assistant message (with id === assistantMessageId), the user
    // message and meta must already be persisted (fire-and-forget is fine),
    // streamingChatIds must include chatId, and any prior stream for this
    // chat must be aborted.
    //
    // The ext appends ONE row at end-of-turn (the assistant message); user-
    // message and edit persistence are the web's responsibility through
    // put_message / save_meta / delete_messages_after.
    private streamForChat(chatId: string, assistantMessageId: string): void {
        const snap = this.chats.find((c) => c.id === chatId);
        if (!snap) return;

        // Attach fresh upload bytes (if any) inline so the provider call can
        // see them. Bare refs pass through and get hydrated server-side from
        // the files store.
        const pending = snap.pendingBlobs;
        const hydrateForApi = (
            attachments: AttachmentRef[] | undefined
        ): (Attachment | AttachmentRef)[] | undefined => {
            if (!attachments?.length) return undefined;
            if (!pending?.size) return attachments;
            return attachments.map((ref) => pending.get(ref.hash) ?? ref);
        };

        const history: ChatMessage[] = snap.messages
            .slice(0, -1)
            .map(({ role, content, attachments, toolResults }) => {
                const atts = hydrateForApi(attachments);
                return {
                    role,
                    content,
                    ...(atts ? { attachments: atts } : {}),
                    ...(toolResults?.length ? { toolResults } : {}),
                };
            });
        const apiMessages = snap.systemPrompt.trim()
            ? [
                  { role: 'system' as const, content: snap.systemPrompt },
                  ...history,
              ]
            : history;

        // Pre-turn message state included in the turn-start broadcast so
        // mirror tabs can render the chat without an extra IDB round-trip.
        // Refs only — fresh blobs are inlined via apiMessages.
        const broadcastHistory: StoredMessage[] = snap.messages
            .slice(0, -1)
            .filter(
                (m): m is Message & { role: 'user' | 'assistant' } =>
                    m.role === 'user' || m.role === 'assistant'
            )
            .map((m) => ({
                chatId,
                id: m.id,
                createdAt: m.createdAt,
                role: m.role,
                content: m.content,
                ...(m.thinking ? { thinking: m.thinking } : {}),
                ...(m.attachments?.length
                    ? { attachments: m.attachments }
                    : {}),
                ...(m.toolResults?.length
                    ? { toolResults: m.toolResults }
                    : {}),
                ...(m.tokens ? { tokens: m.tokens } : {}),
            }));

        const modelParams = providersStore.providers
            .find((p) => p.id === snap.providerId)
            ?.models.find((m) => m.id === snap.modelId)?.params;

        const updateAssistantPlaceholder = (
            mutate: (msg: Message) => Message
        ) => {
            this.chats = this.chats.map((c) => {
                if (c.id !== chatId) return c;
                const msgs = c.messages.map((m) =>
                    m.id === assistantMessageId ? mutate(m) : m
                );
                return { ...c, messages: msgs };
            });
        };

        const finishStream = () => {
            this.streamHandles.delete(chatId);
            this.streamingChatIds = this.streamingChatIds.filter(
                (id) => id !== chatId
            );
        };

        const handle = sendToExtension(
            {
                chatId,
                sourceTabId: tabId,
                provider: snap.providerId,
                model: snap.modelId,
                messages: apiMessages,
                params: {
                    ...(modelParams?.temperatureMax !== undefined
                        ? { temperature: snap.temperature }
                        : {}),
                    maxTokens: snap.maxTokens,
                    thinkingLevel: snap.thinkingLevel,
                    adaptiveThinking: snap.adaptiveThinking,
                    webSearch: settingsStore.enableWebSearch && snap.webSearch,
                    tagOpenRouterRequests: settingsStore.tagOpenRouterRequests,
                },
                meta: chatToMeta(snap),
                history: broadcastHistory,
                assistantMessageId,
            },
            {
                onChunk: (chunk) => {
                    updateAssistantPlaceholder((m) => ({
                        ...m,
                        content: m.content + chunk,
                    }));
                },
                onThinking: (chunk) => {
                    updateAssistantPlaceholder((m) => ({
                        ...m,
                        thinking: (m.thinking ?? '') + chunk,
                    }));
                },
                onToolResults: (toolResults) => {
                    updateAssistantPlaceholder((m) => ({ ...m, toolResults }));
                },
                onDone: (usage) => {
                    finishStream();
                    if (usage) {
                        updateAssistantPlaceholder((m) => ({
                            ...m,
                            tokens: {
                                input: usage.inputTokens,
                                output: usage.outputTokens,
                            },
                        }));
                    }
                    this.chats = this.chats.map((c) =>
                        c.id === chatId ? { ...c, pendingBlobs: undefined } : c
                    );
                },
                onError: (msg, source) => {
                    finishStream();
                    this.chatErrors = {
                        ...this.chatErrors,
                        [chatId]: formatStreamError(msg, source),
                    };
                    // Discard the placeholder only if no content arrived —
                    // keep partial content otherwise.
                    this.chats = this.chats.map((c) => {
                        if (c.id !== chatId) return c;
                        const last = c.messages[c.messages.length - 1];
                        return last?.content
                            ? c
                            : {
                                  ...c,
                                  messages: c.messages.filter(
                                      (m) => m.id !== assistantMessageId
                                  ),
                              };
                    });
                },
            }
        );
        this.streamHandles.set(chatId, handle);
    }

    // --- Remote (cross-tab) turn handlers ---
    //
    // When another tab streams a turn, the extension fans out lifecycle events
    // to every connected tab. We mirror those into local state so the sidebar
    // spinner and same-chat live-render work without any tab needing to poll.

    applyRemoteTurnStart(
        chatId: string,
        meta: ChatMeta,
        history: StoredMessage[],
        assistantMessageId: string
    ): void {
        const placeholder: Message = {
            id: assistantMessageId,
            createdAt: Date.now(),
            role: 'assistant',
            content: '',
        };
        const hydratedHistory = hydrateStoredMessages(history);
        const existing = this.chats.find((c) => c.id === chatId);
        if (existing) {
            this.chats = this.chats.map((c) =>
                c.id === chatId
                    ? { ...c, messages: [...hydratedHistory, placeholder] }
                    : c
            );
        } else {
            const fromUnloaded = this.unloadedMetas.find(
                (m) => m.id === chatId
            );
            const newChat: Chat = {
                ...meta,
                messages: [...hydratedHistory, placeholder],
            };
            this.chats = [newChat, ...this.chats];
            if (fromUnloaded) {
                this.unloadedMetas = this.unloadedMetas.filter(
                    (m) => m.id !== chatId
                );
            }
        }
        if (!this.remoteStreamingChatIds.includes(chatId)) {
            this.remoteStreamingChatIds = [
                ...this.remoteStreamingChatIds,
                chatId,
            ];
        }
        this.clearChatError(chatId);
    }

    applyRemoteTurnChunk(
        chatId: string,
        kind: 'content' | 'thinking',
        delta: string
    ): void {
        if (!this.remoteStreamingChatIds.includes(chatId)) return;
        this.chats = this.chats.map((c) => {
            if (c.id !== chatId) return c;
            if (c.messages.length === 0) return c;
            const msgs = [...c.messages];
            const last = msgs[msgs.length - 1];
            msgs[msgs.length - 1] =
                kind === 'content'
                    ? { ...last, content: last.content + delta }
                    : { ...last, thinking: (last.thinking ?? '') + delta };
            return { ...c, messages: msgs };
        });
    }

    applyRemoteTurnToolResults(
        chatId: string,
        toolResults: ToolResult[]
    ): void {
        if (!this.remoteStreamingChatIds.includes(chatId)) return;
        this.chats = this.chats.map((c) => {
            if (c.id !== chatId) return c;
            if (c.messages.length === 0) return c;
            const msgs = [...c.messages];
            const last = msgs[msgs.length - 1];
            msgs[msgs.length - 1] = { ...last, toolResults };
            return { ...c, messages: msgs };
        });
    }

    async applyRemoteTurnDone(chatId: string): Promise<void> {
        if (!this.remoteStreamingChatIds.includes(chatId)) return;
        this.remoteStreamingChatIds = this.remoteStreamingChatIds.filter(
            (id) => id !== chatId
        );
        // Refresh from IDB for canonical state — the extension just saved.
        let stored: StoredChat | null;
        try {
            stored = await loadChat(chatId);
        } catch (err) {
            console.error(LOG, 'applyRemoteTurnDone: loadChat failed', err);
            errorStore.setAppError(
                `Couldn't refresh chat from storage: ${formatErr(err)}`
            );
            return;
        }
        if (stored) {
            this.chats = this.chats.map((c) =>
                c.id === chatId
                    ? {
                          ...c,
                          messages: hydrateStoredMessages(stored!.messages),
                      }
                    : c
            );
        }
    }

    async applyRemoteTurnAborted(chatId: string): Promise<void> {
        if (!this.remoteStreamingChatIds.includes(chatId)) return;
        this.remoteStreamingChatIds = this.remoteStreamingChatIds.filter(
            (id) => id !== chatId
        );
        // Source tab bailed without saving. IDB has the pre-turn state (or
        // nothing if this was the chat's very first turn).
        let stored: StoredChat | null;
        try {
            stored = await loadChat(chatId);
        } catch (err) {
            console.error(LOG, 'applyRemoteTurnAborted: loadChat failed', err);
            errorStore.setAppError(
                `Couldn't refresh chat from storage: ${formatErr(err)}`
            );
            return;
        }
        if (stored) {
            this.chats = this.chats.map((c) =>
                c.id === chatId
                    ? {
                          ...c,
                          messages: hydrateStoredMessages(stored!.messages),
                      }
                    : c
            );
        } else {
            this.chats = this.chats.filter((c) => c.id !== chatId);
            if (this.activeChatId === chatId) this.activeChatId = null;
        }
    }

    async applyRemoteTurnError(chatId: string, message: string): Promise<void> {
        if (!this.remoteStreamingChatIds.includes(chatId)) return;
        this.remoteStreamingChatIds = this.remoteStreamingChatIds.filter(
            (id) => id !== chatId
        );
        this.chatErrors = {
            ...this.chatErrors,
            [chatId]: formatStreamError(message),
        };
        let stored: StoredChat | null;
        try {
            stored = await loadChat(chatId);
        } catch (err) {
            console.error(LOG, 'applyRemoteTurnError: loadChat failed', err);
            // Per-chat error already set; skip the app-wide one for this
            // secondary refresh failure.
            return;
        }
        if (stored) {
            this.chats = this.chats.map((c) =>
                c.id === chatId
                    ? {
                          ...c,
                          messages: hydrateStoredMessages(stored!.messages),
                      }
                    : c
            );
        }
    }

    async refreshActiveFromIDB(): Promise<void> {
        if (!this.activeChatId) return;
        let stored: StoredChat | null;
        try {
            stored = await loadChat(this.activeChatId);
        } catch (err) {
            console.error(LOG, 'refreshActiveFromIDB failed', err);
            errorStore.setAppError(
                `Couldn't refresh active chat: ${formatErr(err)}`
            );
            return;
        }
        if (!stored) return;
        this.chats = this.chats.map((c) =>
            c.id === this.activeChatId
                ? {
                      ...c,
                      messages: hydrateStoredMessages(stored!.messages),
                  }
                : c
        );
    }
}

export const chatStore = new ChatStore();
