import type {
    Attachment,
    ChatMeta,
    CourierAIChunk,
    CourierAIMessage,
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

// Build a fresh user CourierAIMessage from raw text + attachments. Text
// part comes first so it reads top-to-bottom; attachments hang off as
// `data-attachment` parts referencing bytes via hash.
function buildUserMessage(
    id: string,
    createdAt: number,
    content: string,
    attachments?: Attachment[]
): CourierAIMessage {
    const parts: CourierAIMessage['parts'] = [];
    if (content) {
        parts.push({ type: 'text', text: content, state: 'done' });
    }
    for (const att of attachments ?? []) {
        parts.push({
            type: 'data-attachment',
            data: {
                hash: att.hash,
                name: att.name,
                mediaType: att.mediaType,
                sizeBytes: att.sizeBytes,
            },
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

// Wraps a CourierAIMessage as the put_message payload. `pendingBlobs` is
// the chat's in-flight upload bytes map - we only inline bytes for hashes
// referenced by THIS message, keyed by hash.
function messageToHydrated(
    chatId: string,
    msg: CourierAIMessage,
    pendingBlobs?: Map<string, Attachment>
): HydratedStoredMessage {
    const freshBlobs: HydratedStoredMessage['freshBlobs'] = {};
    let anyFresh = false;
    if (pendingBlobs?.size) {
        for (const part of msg.parts) {
            if (part.type !== 'data-attachment') continue;
            const att = pendingBlobs.get(part.data.hash);
            if (!att) continue;
            freshBlobs[att.hash] = {
                mediaType: att.mediaType,
                base64: att.data,
            };
            anyFresh = true;
        }
    }
    return {
        chatId,
        message: msg,
        ...(anyFresh ? { freshBlobs } : {}),
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
    // Metas for chats not yet loaded into `chats` (older pages). Sorted newest-first.
    unloadedMetas = $state<ChatMeta[]>([]);
    activeChatId = $state<string | null>(null);
    streamingChatIds = new SvelteSet<string>();
    // Chats currently streaming in *other* tabs. Populated from broadcast
    // turn-start events; subsequent chunks/done/error/aborted only apply if
    // the chatId is in this set.
    remoteStreamingChatIds = new SvelteSet<string>();
    chatErrors = $state<Record<string, string>>({});
    searchResults = $state<SearchResult[] | null>(null);
    searchQuery = $state('');
    highlightMessageIndex = $state<number | null>(null);
    chatLoading = $state(false);
    isLoadingMore = $state(false);

    // Demo mode is owned here because it gates chat persistence. Set by
    // appLifecycle when the user picks "look around" without an extension.
    demoMode = $state(false);

    // Handles for active local streams.
    private streamHandles = new Map<string, StreamHandle>();
    // Per-chat message assembler for cross-tab broadcast chunks. Same fold
    // used for local streams - incoming chunks mutate the placeholder
    // assistant message's parts in place.
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
    // Sidebar gets the union - any chat being streamed by any tab gets the
    // spinner. Plain Set keeps the per-row .has() check O(1) without the
    // reactive bookkeeping of SvelteSet (derived is read-only).
    allStreamingChatIds = $derived(
        new Set([...this.streamingChatIds, ...this.remoteStreamingChatIds])
    );
    activeStreamError = $derived(
        this.chatErrors[this.activeChatId ?? ''] ?? null
    );
    activeMessages = $derived(
        this.chats.find((c) => c.id === this.activeChatId)?.messages ?? []
    );
    // Maintained by streamForChat/applyRemoteTurnChunk as an O(1) text
    // mirror of the streaming message. ChatPanel reads this in preference to
    // messageText(last) so the per-chunk path is O(delta) instead of
    // re-joining all parts. Falls to null when no stream is in flight.
    activeStreamingText = $derived(
        this.chats.find((c) => c.id === this.activeChatId)?.streamingText ??
            null
    );
    // Tokens live in the assistant message metadata that produced them.
    // Surface the most recent assistant turn's usage for the indicators.
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

    // --- Initial load + pagination ---

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
            this.chats.push({
                ...meta,
                messages: this.storedToMessages(full.messages),
            });
            const metaIdx = this.unloadedMetas.findIndex((m) => m.id === id);
            if (metaIdx >= 0) this.unloadedMetas.splice(metaIdx, 1);
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
        }
        this.streamingChatIds.delete(id);
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
                if (part.type !== 'data-attachment') continue;
                attachments.push(part.data.name);
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
        // Replace text parts with a single new text part; keep non-text parts
        // (attachments etc.) intact.
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
            putMessage(
                messageToHydrated(chatId, editedMsg, chat.pendingBlobs)
            ).catch((err) => {
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

    // --- Streaming ---

    sendMessage(content: string, attachments?: Attachment[]): void {
        if (this.activeChatId && this.streamingChatIds.has(this.activeChatId))
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
            this.chats.unshift({
                id: chatId,
                title,
                messages: [],
                createdAt: now,
                ...settingsStore.snapshotChatConfig(),
            });
            this.activeChatId = chatId;
        } else {
            // Update config and rename if this is the first message
            const existing = this.chats.find((c) => c.id === chatId);
            const isFirst = (existing?.messages.length ?? 0) === 0;
            if (existing) {
                Object.assign(existing, settingsStore.snapshotChatConfig());
                if (isFirst) existing.title = content.slice(0, 40);
            }
        }

        const userId = crypto.randomUUID();
        const now = Date.now();
        const userMsg = buildUserMessage(userId, now, content, attachments);
        // Pre-allocate the assistant message id so the ext's terminal save
        // uses the same id as our placeholder.
        const assistantId = crypto.randomUUID();
        const assistantPlaceholder = buildAssistantPlaceholder(
            assistantId,
            Date.now()
        );

        const sendChat = this.chats.find((c) => c.id === chatId);
        if (sendChat) {
            sendChat.messages.push(userMsg, assistantPlaceholder);
            if (attachments?.length) {
                const nextPending = new Map(sendChat.pendingBlobs ?? []);
                for (const att of attachments) nextPending.set(att.hash, att);
                sendChat.pendingBlobs = nextPending;
            }
        }

        // Persist meta first if brand new chat, then the user message. Both
        // are fire-and-forget so we don't block stream startup; the ext's
        // put_message refuses to write a message under a missing meta row,
        // so we await meta before the message to avoid that drop.
        if (!this.demoMode) {
            const chat = this.chats.find((c) => c.id === chatId);
            if (chat) {
                const persistUser = () =>
                    putMessage(
                        messageToHydrated(chatId!, userMsg, chat.pendingBlobs)
                    ).catch((err) => {
                        reportAppError(
                            'persist user msg failed',
                            "Couldn't save your message",
                            err
                        );
                    });
                if (createdNewChat) {
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

        // Abort any in-progress stream for this chat
        this.streamHandles.get(chatId)?.abort();
        this.streamHandles.delete(chatId);
        this.streamingChatIds.delete(chatId);

        // If assistant message, treat as retrying the user message above it
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

        // Truncate IDB to match: drop every persisted message after the one
        // we're retrying. Config changes also get persisted so the next
        // turn uses the freshly-selected provider/model on reload.
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

    // Graceful stop. `visibleChars` is the smoothText display length at click
    // time - what the user could actually read. We tell the ext to truncate
    // its assembled message to that length before saving, and mirror the
    // same trim locally so the UI doesn't keep draining content the user
    // wanted to stop seeing. handle.stop runs first so the `stopped` flag
    // gates any chunks already queued on the port before we mutate parts.
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

    // Streams an assistant response into the trailing placeholder of `chatId`.
    // Caller is responsible for prepping the chat: messages must end with an
    // empty assistant message (with id === assistantId), the user
    // message and meta must already be persisted (fire-and-forget is fine),
    // streamingChatIds must include chatId, and any prior stream for this
    // chat must be aborted.
    //
    // The ext appends ONE row at end-of-turn (the assistant message); user-
    // message and edit persistence are the web's responsibility through
    // put_message / save_meta / delete_messages_after.
    private streamForChat(chatId: string, assistantId: string): void {
        const snap = this.chats.find((c) => c.id === chatId);
        if (!snap) return;

        // History sent to the ext: everything except the trailing assistant
        // placeholder. Bare refs travel - the ext loads bytes from its
        // files store by hash. Fresh uploads were inlined when persisting
        // the user message, so by the time the stream starts the ext has
        // every hash this history can reference.
        const history: CourierAIMessage[] = snap.messages.slice(0, -1);

        // Pre-turn message state included in the turn-start broadcast so
        // mirror tabs can render the chat without an extra IDB round-trip.
        const broadcastHistory: StoredMessage[] = history.map((m) => ({
            chatId,
            message: m,
        }));

        const selectedModel = providersStore.providers
            .find((p) => p.id === snap.providerId)
            ?.models.find((m) => m.id === snap.modelId);
        const modelParams = selectedModel?.params;

        // Tool wire payload - AND of (model declares support) ∧ (master toggle
        // on) ∧ (per-chat toggle on). Value is the raw `ToolSupport` the model
        // declared (a string for anthropic, true for everyone else), so the ext
        // doesn't need a duplicate per-model lookup table. Missing keys mean
        // "do not attach the tool".
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

        // Capture the assistant placeholder's $state proxy ref from the
        // array. Mutating the proxy (via the reducer) drives Svelte's
        // fine-grained reactivity per text part - no per-chunk whole-
        // message swap or messageText re-join.
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
                    thinkingLevel: snap.thinkingLevel,
                    adaptiveThinking: snap.adaptiveThinking,
                    tools: wireTools,
                    tagOpenRouterRequests: settingsStore.tagOpenRouterRequests,
                },
                meta: chatToMeta(snap),
                history: broadcastHistory,
                assistantMessageId: assistantId,
            },
            {
                onChunk: (chunk) => {
                    applyCourierAIChunk(assembler, chunk);
                    // O(1) text mirror for the smooth-text effect: appending
                    // text-deltas matches messageText()'s join-all because
                    // deltas arrive in render order.
                    if (chunk.type === 'text-delta')
                        cachedChat.streamingText += chunk.delta;
                },
                onDone: () => {
                    finishStream();
                    cachedChat.pendingBlobs = undefined;
                },
                onError: (msg, source) => {
                    finishStream();
                    this.chatErrors = {
                        ...this.chatErrors,
                        [chatId]: formatStreamError(msg, source),
                    };
                    // Discard the placeholder if no parts arrived; keep
                    // partial content otherwise.
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

    // --- Remote (cross-tab) turn handlers ---
    //
    // When another tab streams a turn, the extension fans out lifecycle
    // events to every connected tab. Each tab feeds incoming chunks into
    // a per-chat message assembler so the in-progress assistant message
    // rebuilds the same way local streams do - no bespoke chunk accumulator.

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
            // Re-fetch via find so `chat` is the $state proxy, not the raw
            // object literal we just unshifted. Mutating the raw bypasses
            // Svelte's proxy and silently drops reactivity notifications.
            chat = this.chats.find((c) => c.id === chatId)!;
            const metaIdx = this.unloadedMetas.findIndex(
                (m) => m.id === chatId
            );
            if (metaIdx >= 0) this.unloadedMetas.splice(metaIdx, 1);
        }
        this.remoteStreamingChatIds.add(chatId);
        this.clearChatError(chatId);

        // Spin up a fresh pipeline for this remote stream. Each chunk goes
        // straight into the assembler, which mutates the placeholder's parts
        // in place - same path as local streamForChat.
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

    // Mirror-tab counterpart to source-tab stop. Source broadcasts the
    // visible char count at click; we trim our local copy of the assistant
    // placeholder to match, so every tab shows the same final text. Smooth's
    // $effect.pre picks up the streamingText change and snaps target down;
    // if its display had drained past `charLen` (mirror tabs drain
    // independently), the next tick collapses display to target.
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

    // Re-hydrate one chat's messages from IDB. `userMessage: null` suppresses
    // the app-wide banner on failure (used by error-path refreshes where a
    // per-chat error is already surfaced). `onMissing: 'drop'` removes the
    // chat from state when IDB has no row (a remote-aborted first turn that
    // never reached the save step).
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
        // Refresh from IDB for canonical state - the extension just saved.
        await this.refreshChatFromIDB(chatId, {
            context: 'applyRemoteTurnDone: loadChat failed',
            userMessage: "Couldn't refresh chat from storage",
        });
    }

    async applyRemoteTurnAborted(chatId: string): Promise<void> {
        if (!this.remoteStreamingChatIds.has(chatId)) return;
        this.remoteStreamingChatIds.delete(chatId);
        this.closeRemotePipeline(chatId);
        // Source tab bailed without saving. IDB has the pre-turn state (or
        // nothing if this was the chat's very first turn).
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
        // Per-chat error already set; suppress the app-wide banner if this
        // secondary refresh also fails.
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
}

export const chatStore = new ChatStore();
