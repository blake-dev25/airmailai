<script lang="ts">
    import type { Attachment, ChatMeta, StoredChat } from '@courier/shared';
    import { onMount, untrack } from 'svelte';
    import ChatPanel from './lib/ChatPanel.svelte';
    import { FONT_SIZES, PROVIDERS } from './lib/constants';
    import ExtensionPrompt from './lib/ExtensionPrompt.svelte';
    import {
        deleteChat,
        loadChat,
        loadChatMetas,
        loadChatsByIds,
        loadSettings,
        saveChat,
        saveSettings,
        sendToExtension,
        waitForExtension,
    } from './lib/extension';
    import ModelConfig from './lib/ModelConfig.svelte';
    import { initMarkdown } from './lib/markdown';
    import Sidebar from './lib/Sidebar.svelte';

    // Preload Shiki in the browser's idle window so the first code block doesn't pay the cost.
    onMount(() => {
        const trigger = () => initMarkdown();
        if ('requestIdleCallback' in window) {
            window.requestIdleCallback(trigger);
        } else {
            setTimeout(trigger, 0);
        }
    });

    const LOG = '[courier:web]';
    console.log(LOG, 'page load', {
        screen: `${window.screen.width}x${window.screen.height}`,
        time: new Date().toISOString(),
    });

    interface Message {
        role: 'user' | 'assistant';
        content: string;
        thinking?: string;
        attachments?: Attachment[];
    }

    interface Chat {
        id: string;
        title: string;
        messages: Message[];
        createdAt: number;
        systemPrompt: string;
        providerId: string;
        modelId: string;
        temperature: number;
        maxTokens: number;
        thinkingLevel: string;
        adaptiveThinking: boolean;
        tokens?: { input: number; output: number };
    }

    interface SearchResult {
        id: string;
        title: string;
        snippet: string;
        matchIndex: number | null;
    }

    const PAGE_SIZE = 40;

    // Theme
    let theme = $state('airmail-warm');
    $effect(() => {
        document.documentElement.dataset.theme = theme;
    });

    // Font size — default based on screen width
    function getDefaultFontSizeIndex(): number {
        const w = window.screen.width;
        if (w <= 1366) return 1; // 16px — small laptop
        if (w <= 1920) return 2; // 18px — standard
        return 2; // 18px — large/4K
    }
    let fontSizeIndex = $state(getDefaultFontSizeIndex());
    $effect(() => {
        document.documentElement.style.fontSize = `${FONT_SIZES[fontSizeIndex]}px`;
    });

    // Chat width — 0 to 100, interpolates between 744px (narrowest) and 100vw (widest)
    let chatWidth = $state(0);
    // Smooth text loading — animate streaming text with rAF drain
    let smoothText = $state(true);
    // Submit keystroke — 'enter' or 'ctrl+enter'
    let submitKeystroke = $state<'enter' | 'ctrl+enter'>('enter');

    // Model config
    const defaultModel = PROVIDERS[0].models[1]; // Sonnet as default
    let providerId = $state(PROVIDERS[0].id);
    let modelId = $state(defaultModel.id);
    let temperature = $state<number>(defaultModel.params.defaultTemperature ?? 1);
    let maxTokens = $state(defaultModel.params.defaultMaxTokens);
    let thinkingLevel = $state<string>(
        defaultModel.params.thinking?.defaultLevel ?? 'none',
    );
    let adaptiveThinking = $state<boolean>(
        defaultModel.params.thinking?.adaptive !== undefined,
    );
    let systemPrompt = $state('');

    // Chats
    let chats = $state<Chat[]>([]);
    // All chat metas sorted newest-first — used to track total count for pagination
    let allMetas = $state<ChatMeta[]>([]);
    let hasMoreChats = $derived(chats.length < allMetas.length);
    let isLoadingMore = $state(false);
    let activeChatId = $state<string | null>(null);
    let streamingChatIds = $state<string[]>([]);
    let chatErrors = $state<Record<string, string>>({});
    let searchResults = $state<SearchResult[] | null>(null);
    let searchQuery = $state('');
    let highlightMessageIndex = $state<number | null>(null);
    let isActiveStreaming = $derived(
        streamingChatIds.includes(activeChatId ?? ''),
    );
    let activeStreamError = $derived(chatErrors[activeChatId ?? ''] ?? null);
    let activeMessages = $derived(
        chats.find((c) => c.id === activeChatId)?.messages ?? [],
    );
    let activeModelName = $derived(
        PROVIDERS.find((p) => p.id === providerId)?.models.find(
            (m) => m.id === modelId,
        )?.name ?? modelId,
    );
    let activeTokens = $derived(
        chats.find((c) => c.id === activeChatId)?.tokens ?? null,
    );

    // --- Storage ---

    let settingsLoaded = $state(false);
    let chatLoading = $state(false);
    let demoMode = $state(false);
    let showExtensionPrompt = $state(false);

    // Tracks which chat IDs have full messages loaded in memory
    const loadedChatIds = new Set<string>();
    // Disconnect functions for active streams — call to abort a stream early
    const streamDisconnects = new Map<string, () => void>();

    waitForExtension().then(async (detected) => {
        if (!detected) showExtensionPrompt = true;
        console.log(LOG, 'extension detected:', detected);

        const [settings, metas] = await Promise.all([
            loadSettings(),
            loadChatMetas(),
        ]);

        console.log(LOG, 'settings loaded', settings);
        if (settings.theme) theme = settings.theme;
        if (settings.fontSizeIndex !== undefined)
            fontSizeIndex = settings.fontSizeIndex;
        if (settings.chatWidth !== undefined) chatWidth = settings.chatWidth;
        if (settings.smoothText !== undefined) smoothText = settings.smoothText;
        if (settings.submitKeystroke !== undefined)
            submitKeystroke = settings.submitKeystroke;
        if (settings.providerId) providerId = settings.providerId;
        if (settings.modelId) modelId = settings.modelId;
        if (settings.temperature !== undefined)
            temperature = settings.temperature;
        if (settings.maxTokens !== undefined) maxTokens = settings.maxTokens;
        if (settings.thinkingLevel !== undefined)
            thinkingLevel = settings.thinkingLevel;
        if (settings.adaptiveThinking !== undefined)
            adaptiveThinking = settings.adaptiveThinking;

        settingsLoaded = true;

        const sorted = metas.sort((a, b) => b.createdAt - a.createdAt);
        allMetas = sorted;
        console.log(LOG, 'chat metas loaded', `${sorted.length} chats`);

        // Load first page of full chats
        const firstIds = sorted.slice(0, PAGE_SIZE).map((t) => t.id);
        if (firstIds.length > 0) {
            const fullChats = await loadChatsByIds(firstIds);
            const byId = new Map(fullChats.map((c) => [c.id, c]));
            const metaById = new Map(sorted.map((t) => [t.id, t]));
            chats = firstIds
                .map((id) => {
                    const stored = byId.get(id);
                    const meta = metaById.get(id);
                    if (!stored || !meta) return null;
                    return {
                        ...meta,
                        messages: stored.messages,
                        ...(stored.tokens ? { tokens: stored.tokens } : {}),
                    };
                })
                .filter((c): c is Chat => c !== null);
            for (const id of firstIds) loadedChatIds.add(id);
            console.log(LOG, 'first page loaded', `${chats.length} chats`);
        }
    });

    async function loadMoreChats() {
        if (isLoadingMore || !hasMoreChats) return;
        isLoadingMore = true;
        // chats.length == number loaded so far == offset into allMetas
        const nextIds = allMetas
            .slice(chats.length, chats.length + PAGE_SIZE)
            .map((t) => t.id);
        const fullChats = await loadChatsByIds(nextIds);
        const byId = new Map(fullChats.map((c) => [c.id, c]));
        const metaById = new Map(allMetas.map((t) => [t.id, t]));
        const newChats = nextIds
            .map((id) => {
                const stored = byId.get(id);
                const meta = metaById.get(id);
                if (!stored || !meta) return null;
                return {
                    ...meta,
                    messages: stored.messages,
                    ...(stored.tokens ? { tokens: stored.tokens } : {}),
                };
            })
            .filter((c): c is Chat => c !== null);
        chats = [...chats, ...newChats];
        for (const id of nextIds) loadedChatIds.add(id);
        console.log(
            LOG,
            'loaded more chats',
            `${newChats.length} chats, total ${chats.length}`,
        );
        isLoadingMore = false;
    }

    function search(query: string) {
        searchQuery = query;
        highlightMessageIndex = null;
        const q = query.toLowerCase();
        const results: SearchResult[] = [];
        for (const chat of chats) {
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
                        (start > 0 ? '…' : '') +
                        content.slice(start, end) +
                        (end < content.length ? '…' : '');
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
                      (firstMsg.content.length > 100 ? '…' : '')
                    : '';
                results.push({
                    id: chat.id,
                    title: chat.title,
                    snippet,
                    matchIndex: null,
                });
            }
        }
        searchResults = results;
    }

    function clearSearch() {
        searchResults = null;
        searchQuery = '';
        highlightMessageIndex = null;
    }

    // Debounced save — fires 300ms after any settings change (but not during initial load)
    $effect(() => {
        const snapshot = {
            theme,
            fontSizeIndex,
            chatWidth,
            smoothText,
            submitKeystroke,
            providerId,
            modelId,
            temperature,
            maxTokens,
            thinkingLevel,
            adaptiveThinking,
        };
        if (!untrack(() => settingsLoaded)) return;
        if (untrack(() => demoMode)) return;
        const timer = setTimeout(() => {
            console.log(LOG, 'settings save (debounced)', snapshot);
            saveSettings(snapshot);
        }, 300);
        return () => clearTimeout(timer);
    });

    function chatToStored(chat: Chat, messages = chat.messages): StoredChat {
        return {
            id: chat.id,
            messages,
            ...(chat.tokens ? { tokens: chat.tokens } : {}),
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
            systemPrompt: chat.systemPrompt,
        };
    }

    // --- Demo mode ---

    function enterDemoMode() {
        const fizzbuzz =
            "sure! here's your script:\n\n" +
            '```python\n' +
            'for i in range(1, 101):\n' +
            '    if i % 15 == 0:\n' +
            '        print("FizzBuzz")\n' +
            '    elif i % 3 == 0:\n' +
            '        print("Fizz")\n' +
            '    elif i % 5 == 0:\n' +
            '        print("Buzz")\n' +
            '    else:\n' +
            '        print(i)\n' +
            '```';
        const now = Date.now();
        const demo1: Chat = {
            id: 'demo-1',
            title: 'this is a demo conversation',
            messages: [
                { role: 'user', content: 'this is a demo conversation' },
                { role: 'assistant', content: 'great! how can I help you?' },
            ],
            createdAt: now,
            systemPrompt: '',
            providerId,
            modelId,
            temperature,
            maxTokens,
            thinkingLevel,
            adaptiveThinking,
        };
        const demo2: Chat = {
            id: 'demo-2',
            title: 'write me a python fizzbuzz script',
            messages: [
                { role: 'user', content: 'write me a python fizzbuzz script' },
                { role: 'assistant', content: fizzbuzz },
            ],
            createdAt: now - 1000,
            systemPrompt: '',
            providerId,
            modelId,
            temperature,
            maxTokens,
            thinkingLevel,
            adaptiveThinking,
        };
        chats = [demo1, demo2];
        allMetas = chats.map(chatToMeta);
        loadedChatIds.add('demo-1');
        loadedChatIds.add('demo-2');
        activeChatId = 'demo-1';
        demoMode = true;
        showExtensionPrompt = false;
        console.log(LOG, 'entered demo mode');
    }

    function requestExtension() {
        showExtensionPrompt = true;
    }

    // --- Chat actions ---

    function newChat() {
        const id = crypto.randomUUID();
        const now = Date.now();
        console.log(LOG, 'new chat', id);
        chats = [
            {
                id,
                title: 'New Chat',
                messages: [],
                createdAt: now,
                systemPrompt,
                providerId,
                modelId,
                temperature,
                maxTokens,
                thinkingLevel,
                adaptiveThinking,
            },
            ...chats,
        ];
        allMetas = [
            {
                id,
                title: 'New Chat',
                createdAt: now,
                providerId,
                modelId,
                temperature,
                maxTokens,
                thinkingLevel,
                adaptiveThinking,
                systemPrompt,
            },
            ...allMetas,
        ];
        loadedChatIds.add(id);
        activeChatId = id;
    }

    async function selectChat(id: string, matchIndex?: number | null) {
        highlightMessageIndex = matchIndex ?? null;
        console.log(LOG, 'select chat', id);
        activeChatId = id;

        // Restore model config + system prompt from saved meta
        const meta = allMetas.find((t) => t.id === id);
        if (meta) {
            providerId = meta.providerId;
            modelId = meta.modelId;
            temperature = meta.temperature;
            maxTokens = meta.maxTokens;
            thinkingLevel = meta.thinkingLevel;
            adaptiveThinking = meta.adaptiveThinking ?? true;
            systemPrompt = meta.systemPrompt;
        }

        if (loadedChatIds.has(id)) return;

        // Background load hasn't finished yet — fetch this chat on demand
        chatLoading = true;
        const full = await loadChat(id);
        chatLoading = false;

        if (full && activeChatId === id) {
            loadedChatIds.add(full.id);
            chats = chats.map((c) =>
                c.id === id
                    ? { ...c, messages: full.messages, tokens: full.tokens }
                    : c,
            );
        }
    }

    function removeChat(id: string) {
        console.log(LOG, 'remove chat', id);
        streamDisconnects.get(id)?.();
        streamDisconnects.delete(id);
        loadedChatIds.delete(id);
        chats = chats.filter((c) => c.id !== id);
        allMetas = allMetas.filter((t) => t.id !== id);
        if (activeChatId === id) {
            activeChatId = null;
            systemPrompt = '';
        }
        streamingChatIds = streamingChatIds.filter((sid) => sid !== id);
        if (chatErrors[id]) {
            const { [id]: _, ...rest } = chatErrors;
            chatErrors = rest;
        }
        if (!demoMode) deleteChat(id).catch(console.error);
    }

    function renameChat(id: string, newTitle: string) {
        console.log(LOG, 'rename chat', id, newTitle);
        chats = chats.map((c) => (c.id === id ? { ...c, title: newTitle } : c));
        allMetas = allMetas.map((m) =>
            m.id === id ? { ...m, title: newTitle } : m,
        );
        const updated = chats.find((c) => c.id === id);
        if (updated && !demoMode)
            saveChat(chatToStored(updated), chatToMeta(updated)).catch(
                console.error,
            );
    }

    async function exportChat(id: string) {
        const chat = chats.find((c) => c.id === id);
        if (!chat) return;

        let messages = chat.messages;
        if (!loadedChatIds.has(id) || messages.length === 0) {
            const full = await loadChat(id);
            if (full) messages = full.messages;
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

    function sendMessage(content: string, attachments?: Attachment[]) {
        if (demoMode) {
            requestExtension();
            return;
        }
        if (activeChatId && streamingChatIds.includes(activeChatId)) return;
        console.log(LOG, 'send message', {
            provider: providerId,
            model: modelId,
            contentLength: content.length,
            attachmentCount: attachments?.length ?? 0,
            existingChat: activeChatId,
        });

        // Auto-create a chat on first message
        let chatId = activeChatId;
        if (!chatId) {
            chatId = crypto.randomUUID();
            const now = Date.now();
            const title = content.slice(0, 40);
            chats = [
                {
                    id: chatId,
                    title,
                    messages: [],
                    createdAt: now,
                    systemPrompt,
                    providerId,
                    modelId,
                    temperature,
                    maxTokens,
                    thinkingLevel,
                    adaptiveThinking,
                },
                ...chats,
            ];
            allMetas = [
                {
                    id: chatId,
                    title,
                    createdAt: now,
                    providerId,
                    modelId,
                    temperature,
                    maxTokens,
                    thinkingLevel,
                    adaptiveThinking,
                    systemPrompt,
                },
                ...allMetas,
            ];
            loadedChatIds.add(chatId);
            activeChatId = chatId;
        } else {
            // Update config and rename if this is the first message
            const isFirst =
                (chats.find((c) => c.id === chatId)?.messages.length ?? 0) ===
                0;
            chats = chats.map((c) => {
                if (c.id !== chatId) return c;
                return {
                    ...c,
                    systemPrompt,
                    providerId,
                    modelId,
                    temperature,
                    maxTokens,
                    thinkingLevel,
                    adaptiveThinking,
                    ...(isFirst ? { title: content.slice(0, 40) } : {}),
                };
            });
            allMetas = allMetas.map((t) => {
                if (t.id !== chatId) return t;
                return {
                    ...t,
                    providerId,
                    modelId,
                    temperature,
                    maxTokens,
                    thinkingLevel,
                    adaptiveThinking,
                    systemPrompt,
                    ...(isFirst ? { title: content.slice(0, 40) } : {}),
                };
            });
        }

        // Add user message, then empty assistant placeholder for streaming
        const userMsg: Message = {
            role: 'user',
            content,
            ...(attachments?.length ? { attachments } : {}),
        };
        const assistantMsg: Message = { role: 'assistant', content: '' };
        chats = chats.map((c) =>
            c.id === chatId
                ? { ...c, messages: [...c.messages, userMsg, assistantMsg] }
                : c,
        );

        streamingChatIds = [...streamingChatIds, chatId];
        // Clear any prior error for this chat
        if (chatErrors[chatId]) {
            const { [chatId]: _, ...rest } = chatErrors;
            chatErrors = rest;
        }

        const chatSnapshot = chats.find((c) => c.id === chatId)!;

        // Build message history for the API (exclude the empty placeholder, strip thinking)
        const history = chatSnapshot.messages
            .slice(0, -1)
            .map(({ role, content, attachments }) => ({
                role,
                content,
                ...(attachments ? { attachments } : {}),
            }));
        const apiMessages = systemPrompt.trim()
            ? [{ role: 'system' as const, content: systemPrompt }, ...history]
            : history;

        const modelParams = PROVIDERS.find((p) => p.id === providerId)
            ?.models.find((m) => m.id === modelId)?.params;
        const disconnect = sendToExtension(
            {
                provider: providerId,
                model: modelId,
                messages: apiMessages,
                params: {
                    ...(modelParams?.temperatureMax !== undefined ? { temperature } : {}),
                    maxTokens,
                    thinkingLevel,
                    adaptiveThinking,
                },
            },
            (chunk) => {
                // Append chunk to the last message in the target chat
                chats = chats.map((c) => {
                    if (c.id !== chatId) return c;
                    const msgs = [...c.messages];
                    msgs[msgs.length - 1] = {
                        ...msgs[msgs.length - 1],
                        content: msgs[msgs.length - 1].content + chunk,
                    };
                    return { ...c, messages: msgs };
                });
            },
            (usage) => {
                streamDisconnects.delete(chatId as string);
                streamingChatIds = streamingChatIds.filter(
                    (id) => id !== chatId,
                );
                chats = chats.map((c) => {
                    if (c.id !== chatId) return c;
                    return usage
                        ? {
                              ...c,
                              tokens: {
                                  input: usage.inputTokens,
                                  output: usage.outputTokens,
                              },
                          }
                        : c;
                });
                const done = chats.find((c) => c.id === chatId);
                if (done)
                    saveChat(chatToStored(done), chatToMeta(done)).catch(
                        console.error,
                    );
            },
            (msg) => {
                streamDisconnects.delete(chatId as string);
                streamingChatIds = streamingChatIds.filter(
                    (id) => id !== chatId,
                );
                chatErrors = {
                    ...chatErrors,
                    [chatId as string]: `API Error: ${msg}`,
                };
                // Discard the placeholder only if no content arrived — keep partial content otherwise
                chats = chats.map((c) => {
                    if (c.id !== chatId) return c;
                    const last = c.messages[c.messages.length - 1];
                    return last?.content
                        ? c
                        : { ...c, messages: c.messages.slice(0, -1) };
                });
                const errored = chats.find((c) => c.id === chatId);
                if (errored)
                    saveChat(chatToStored(errored), chatToMeta(errored)).catch(
                        console.error,
                    );
            },
            (thinkingChunk) => {
                chats = chats.map((c) => {
                    if (c.id !== chatId) return c;
                    const msgs = [...c.messages];
                    const last = msgs[msgs.length - 1];
                    msgs[msgs.length - 1] = {
                        ...last,
                        thinking: (last.thinking ?? '') + thinkingChunk,
                    };
                    return { ...c, messages: msgs };
                });
            },
        );
        streamDisconnects.set(chatId as string, disconnect);
    }

    function retryMessage(index: number) {
        if (demoMode) {
            requestExtension();
            return;
        }
        if (!activeChatId) return;
        const chatId = activeChatId;
        const chat = chats.find((c) => c.id === chatId);
        if (!chat) return;

        // Abort any in-progress stream for this chat
        streamDisconnects.get(chatId)?.();
        streamDisconnects.delete(chatId);
        streamingChatIds = streamingChatIds.filter((id) => id !== chatId);

        // If assistant message, treat as retrying the user message above it
        const msg = chat.messages[index];
        const keepUpTo = msg.role === 'user' ? index : index - 1;
        if (keepUpTo < 0) return;

        const truncated: typeof chat.messages = [
            ...chat.messages.slice(0, keepUpTo + 1),
            { role: 'assistant', content: '' },
        ];
        chats = chats.map((c) =>
            c.id === chatId ? { ...c, messages: truncated } : c,
        );

        if (chatErrors[chatId]) {
            const { [chatId]: _, ...rest } = chatErrors;
            chatErrors = rest;
        }
        streamingChatIds = [...streamingChatIds, chatId];

        const snap = chats.find((c) => c.id === chatId)!;
        const history = snap.messages
            .slice(0, -1)
            .map(({ role, content, attachments }) => ({
                role,
                content,
                ...(attachments ? { attachments } : {}),
            }));
        const apiMessages = snap.systemPrompt.trim()
            ? [
                  { role: 'system' as const, content: snap.systemPrompt },
                  ...history,
              ]
            : history;

        const disconnect = sendToExtension(
            {
                provider: snap.providerId,
                model: snap.modelId,
                messages: apiMessages,
                params: {
                    temperature: snap.temperature,
                    maxTokens: snap.maxTokens,
                    thinkingLevel: snap.thinkingLevel,
                    adaptiveThinking: snap.adaptiveThinking,
                },
            },
            (chunk) => {
                chats = chats.map((c) => {
                    if (c.id !== chatId) return c;
                    const msgs = [...c.messages];
                    msgs[msgs.length - 1] = {
                        ...msgs[msgs.length - 1],
                        content: msgs[msgs.length - 1].content + chunk,
                    };
                    return { ...c, messages: msgs };
                });
            },
            (usage) => {
                streamDisconnects.delete(chatId);
                streamingChatIds = streamingChatIds.filter(
                    (id) => id !== chatId,
                );
                chats = chats.map((c) => {
                    if (c.id !== chatId) return c;
                    return usage
                        ? {
                              ...c,
                              tokens: {
                                  input: usage.inputTokens,
                                  output: usage.outputTokens,
                              },
                          }
                        : c;
                });
                const done = chats.find((c) => c.id === chatId);
                if (done)
                    saveChat(chatToStored(done), chatToMeta(done)).catch(
                        console.error,
                    );
            },
            (errMsg) => {
                streamDisconnects.delete(chatId);
                streamingChatIds = streamingChatIds.filter(
                    (id) => id !== chatId,
                );
                chatErrors = {
                    ...chatErrors,
                    [chatId]: `API Error: ${errMsg}`,
                };
                chats = chats.map((c) => {
                    if (c.id !== chatId) return c;
                    const last = c.messages[c.messages.length - 1];
                    return last?.content
                        ? c
                        : { ...c, messages: c.messages.slice(0, -1) };
                });
                const errored = chats.find((c) => c.id === chatId);
                if (errored)
                    saveChat(chatToStored(errored), chatToMeta(errored)).catch(
                        console.error,
                    );
            },
            (thinkingChunk) => {
                chats = chats.map((c) => {
                    if (c.id !== chatId) return c;
                    const msgs = [...c.messages];
                    const last = msgs[msgs.length - 1];
                    msgs[msgs.length - 1] = {
                        ...last,
                        thinking: (last.thinking ?? '') + thinkingChunk,
                    };
                    return { ...c, messages: msgs };
                });
            },
        );
        streamDisconnects.set(chatId, disconnect);
    }

    function editMessage(index: number, content: string) {
        if (!activeChatId) return;
        const chatId = activeChatId;
        chats = chats.map((c) => {
            if (c.id !== chatId) return c;
            const msgs = [...c.messages];
            msgs[index] = { ...msgs[index], content };
            return { ...c, messages: msgs };
        });
        const updated = chats.find((c) => c.id === chatId);
        if (updated && !demoMode)
            saveChat(chatToStored(updated), chatToMeta(updated)).catch(
                console.error,
            );
    }

    function deleteMessage(index: number) {
        if (!activeChatId) return;
        const chatId = activeChatId;
        chats = chats.map((c) => {
            if (c.id !== chatId) return c;
            return { ...c, messages: c.messages.filter((_, i) => i !== index) };
        });
        const updated = chats.find((c) => c.id === chatId);
        if (updated && !demoMode)
            saveChat(chatToStored(updated), chatToMeta(updated)).catch(
                console.error,
            );
    }
</script>

{#if showExtensionPrompt}
    <ExtensionPrompt onlookaround={enterDemoMode} />
{/if}

<div class="app">
    <Sidebar
        {chats}
        {activeChatId}
        {hasMoreChats}
        {isLoadingMore}
        {streamingChatIds}
        {chatErrors}
        {searchResults}
        {searchQuery}
        {demoMode}
        bind:theme
        bind:fontSizeIndex
        bind:chatWidth
        bind:smoothText
        bind:submitKeystroke
        onnewchat={newChat}
        onselectchat={selectChat}
        ondeletechat={removeChat}
        onrenamechat={renameChat}
        onexportchat={exportChat}
        onloadmore={loadMoreChats}
        onsearch={search}
        onclearsearch={clearSearch}
        onextensionneeded={requestExtension}
    />
    <ChatPanel
        messages={activeMessages}
        modelName={activeModelName}
        isStreaming={isActiveStreaming}
        streamError={activeStreamError}
        {chatWidth}
        {smoothText}
        {submitKeystroke}
        loading={chatLoading}
        bind:systemPrompt
        {highlightMessageIndex}
        {demoMode}
        onsend={sendMessage}
        onretry={retryMessage}
        onedit={editMessage}
        ondelete={deleteMessage}
        onextensionneeded={requestExtension}
    />
    <ModelConfig
        bind:providerId
        bind:modelId
        bind:temperature
        bind:maxTokens
        bind:thinkingLevel
        bind:adaptiveThinking
        tokens={activeTokens}
    />
</div>

<style>
    .app {
        display: flex;
        height: 100vh;
        overflow: hidden;
    }
</style>
