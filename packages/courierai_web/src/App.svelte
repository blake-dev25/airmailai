<script lang="ts">
    import type {
        Attachment,
        BroadcastEvent,
        ChatMeta,
        StoredChat,
        UserSettings,
    } from '@courier/shared';
    import { SETTINGS_KEYS } from '@courier/shared';
    import { onMount, untrack } from 'svelte';
    import { detectBrowser } from './lib/browser';
    import ChatPanel from './lib/ChatPanel.svelte';
    import {
        buildOpenRouterProvider,
        FONT_SIZES,
        filterProvidersByTier,
        type ModelTier,
        PROVIDERS,
        type ProviderOption,
    } from './lib/constants';
    import { buildDemoChats } from './lib/demo';
    import ExtensionPrompt from './lib/ExtensionPrompt.svelte';
    import {
        deleteChat,
        loadChat,
        loadChatMetas,
        loadChatsByIds,
        loadOpenRouterModels,
        loadSettings,
        type StreamHandle,
        saveChat,
        saveSettings,
        sendToExtension,
        subscribeToBroadcast,
        tabId,
        waitForExtension,
    } from './lib/extension';
    import ModelConfig from './lib/ModelConfig.svelte';
    import { initMarkdown } from './lib/markdown';
    import Sidebar from './lib/Sidebar.svelte';
    import type { Chat, Message, SearchResult } from './lib/types';

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

    const INITIAL_PAGE_SIZE = 40;
    const LOAD_MORE_PAGE_SIZE = 15;

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
    // Smooth text rendering — controls how streaming AI message text is drained to the UI
    let smoothTextMode = $state<
        'smooth' | 'boost-on-complete' | 'dump-on-complete' | 'raw'
    >('smooth');
    // Submit keystroke — 'enter' or 'ctrl+enter'
    let submitKeystroke = $state<'enter' | 'ctrl+enter'>('enter');

    // Model tier — controls which models surface in the picker
    let modelTier = $state<ModelTier>('latest');
    // Autoscroll — scroll to the bottom as text streams in
    let autoscroll = $state(false);
    // Tag OpenRouter requests with appTitle/httpReferer for app tracking
    let tagOpenRouterRequests = $state(false);
    // OpenRouter free-model handling: show all, only free, or hide free
    let openRouterFreeModels = $state<'show' | 'only' | 'hide'>('show');
    // API keys stay on this device unless the user opts into browser-account sync.
    let syncApiKeys = $state(false);

    // Model config
    // OpenRouter's catalog hydrates async; the rest are static. The local
    // `providers` state lets us swap the OpenRouter entry once it's ready
    // without re-rendering the world.
    let providers = $state<ProviderOption[]>(PROVIDERS);
    const defaultModel = PROVIDERS[0].models[1]; // Sonnet as default
    let providerId = $state(PROVIDERS[0].id);
    let modelId = $state(defaultModel.id);
    let temperature = $state<number>(
        defaultModel.params.defaultTemperature ?? 1,
    );
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
    // Metas for chats not yet loaded into `chats` (older pages). Sorted newest-first.
    let unloadedMetas = $state<ChatMeta[]>([]);
    let hasMoreChats = $derived(unloadedMetas.length > 0);
    let isLoadingMore = $state(false);
    let activeChatId = $state<string | null>(null);
    let streamingChatIds = $state<string[]>([]);
    // Chats currently streaming in *other* tabs. Populated from broadcast
    // turn-start events; subsequent chunks/done/error/aborted only apply if
    // the chatId is in this set.
    let remoteStreamingChatIds = $state<string[]>([]);
    let chatErrors = $state<Record<string, string>>({});
    let searchResults = $state<SearchResult[] | null>(null);
    let searchQuery = $state('');
    let highlightMessageIndex = $state<number | null>(null);
    let isActiveLocalStreaming = $derived(
        streamingChatIds.includes(activeChatId ?? ''),
    );
    let isActiveRemoteStreaming = $derived(
        remoteStreamingChatIds.includes(activeChatId ?? ''),
    );
    let isActiveStreaming = $derived(
        isActiveLocalStreaming || isActiveRemoteStreaming,
    );
    // Sidebar gets the union — any chat being streamed by any tab gets the
    // spinner indicator.
    let allStreamingChatIds = $derived([
        ...streamingChatIds,
        ...remoteStreamingChatIds,
    ]);
    let activeStreamError = $derived(chatErrors[activeChatId ?? ''] ?? null);
    let activeMessages = $derived(
        chats.find((c) => c.id === activeChatId)?.messages ?? [],
    );
    let activeTokens = $derived(
        chats.find((c) => c.id === activeChatId)?.tokens ?? null,
    );

    // When the user changes tier and the active model is no longer in the
    // filtered list, snap to the first model of the first filtered provider.
    // Skip the snap when the active chat already has messages — the stored
    // model is the source of truth and stays visible even if out-of-tier.
    // Plain let (not $state) — non-reactive marker for the effect to compare.
    let lastSnappedTier: ModelTier | null = null;
    $effect(() => {
        const tier = modelTier;
        if (!settingsLoaded) return;
        if (lastSnappedTier === null) {
            lastSnappedTier = tier;
            return;
        }
        if (tier === lastSnappedTier) return;
        lastSnappedTier = tier;
        untrack(() => {
            const active = chats.find((c) => c.id === activeChatId);
            if ((active?.messages.length ?? 0) > 0) return;
            const filtered = filterProvidersByTier(providers, tier);
            const provider = filtered.find((p) => p.id === providerId);
            if (!provider) {
                const fallback = filtered[0] ?? providers[0];
                providerId = fallback.id;
                modelId = fallback.models[0].id;
                return;
            }
            if (!provider.models.find((m) => m.id === modelId)) {
                if (!provider.models[0]) return;
                modelId = provider.models[0].id;
            }
        });
    });

    // --- Storage ---

    let settingsLoaded = $state(false);
    // Flips true after the initial extension/settings/chats load completes
    // (or times out into the no-extension path). Gates UI sections that would
    // otherwise flash defaults before the real data arrives.
    let initialized = $state(false);
    let chatLoading = $state(false);
    let demoMode = $state(false);
    let showExtensionPrompt = $state(false);
    let promptVariant = $state<
        'no-extension' | 'unsupported-browser' | 'mobile'
    >('no-extension');

    // Handles for active streams — abort() hard-cancels (no save), stop()
    // gracefully halts and saves with truncated visible content.
    const streamHandles = new Map<string, StreamHandle>();

    async function hydrateOpenRouterModels() {
        const raw = await loadOpenRouterModels();
        if (!raw || raw.length === 0) return;
        const built = buildOpenRouterProvider(raw);
        providers = providers.map((p) => (p.id === 'openrouter' ? built : p));
        console.log(LOG, 'openrouter hydrated', `${raw.length} models`);
    }

    waitForExtension().then(async (detected) => {
        if (!detected) {
            const browser = detectBrowser();
            promptVariant =
                browser === 'mobile'
                    ? 'mobile'
                    : browser === 'other-desktop'
                      ? 'unsupported-browser'
                      : 'no-extension';
            showExtensionPrompt = true;
        }
        console.log(LOG, 'extension detected:', detected);

        // Fire-and-forget: doesn't gate `initialized` since the rest of the UI
        // works without OpenRouter. Without a key this is cache-only, so it
        // never makes an unauthenticated OpenRouter request.
        if (detected) {
            hydrateOpenRouterModels().catch(console.error);
        }

        const [settings, metas] = await Promise.all([
            loadSettings(),
            loadChatMetas(),
        ]);

        console.log(LOG, 'settings loaded', settings);
        // The mapped type forces every UserSettings field to have a setter —
        // adding a field to UserSettings without listing it here is a TS error.
        const setSetting: {
            [K in keyof UserSettings]: (v: UserSettings[K]) => void;
        } = {
            theme: (v) => {
                theme = v;
            },
            fontSizeIndex: (v) => {
                fontSizeIndex = v;
            },
            chatWidth: (v) => {
                chatWidth = v;
            },
            smoothTextMode: (v) => {
                smoothTextMode = v;
            },
            submitKeystroke: (v) => {
                submitKeystroke = v;
            },
            modelTier: (v) => {
                modelTier = v;
            },
            autoscroll: (v) => {
                autoscroll = v;
            },
            providerId: (v) => {
                providerId = v;
            },
            modelId: (v) => {
                modelId = v;
            },
            temperature: (v) => {
                temperature = v;
            },
            maxTokens: (v) => {
                maxTokens = v;
            },
            thinkingLevel: (v) => {
                thinkingLevel = v;
            },
            adaptiveThinking: (v) => {
                adaptiveThinking = v;
            },
            tagOpenRouterRequests: (v) => {
                tagOpenRouterRequests = v;
            },
            openRouterFreeModels: (v) => {
                openRouterFreeModels = v;
            },
            syncApiKeys: (v) => {
                syncApiKeys = v;
            },
        };
        for (const key of SETTINGS_KEYS) {
            const v = settings[key];
            if (v !== undefined) (setSetting[key] as (val: unknown) => void)(v);
        }

        settingsLoaded = true;

        const sorted = metas.sort((a, b) => b.createdAt - a.createdAt);
        console.log(LOG, 'chat metas loaded', `${sorted.length} chats`);

        const firstPage = sorted.slice(0, INITIAL_PAGE_SIZE);
        unloadedMetas = sorted.slice(INITIAL_PAGE_SIZE);

        if (firstPage.length > 0) {
            const fullChats = await loadChatsByIds(firstPage.map((m) => m.id));
            const byId = new Map(fullChats.map((c) => [c.id, c]));
            chats = firstPage
                .map((meta) => {
                    const stored = byId.get(meta.id);
                    if (!stored) return null;
                    return {
                        ...meta,
                        messages: stored.messages,
                        ...(stored.tokens ? { tokens: stored.tokens } : {}),
                    };
                })
                .filter((c): c is Chat => c !== null);
            console.log(LOG, 'first page loaded', `${chats.length} chats`);
        }

        initialized = true;
    });

    async function loadMoreChats() {
        if (isLoadingMore || unloadedMetas.length === 0) return;
        isLoadingMore = true;
        const nextPage = unloadedMetas.slice(0, LOAD_MORE_PAGE_SIZE);
        const fullChats = await loadChatsByIds(nextPage.map((m) => m.id));
        const byId = new Map(fullChats.map((c) => [c.id, c]));
        const newChats = nextPage
            .map((meta) => {
                const stored = byId.get(meta.id);
                if (!stored) return null;
                return {
                    ...meta,
                    messages: stored.messages,
                    ...(stored.tokens ? { tokens: stored.tokens } : {}),
                };
            })
            .filter((c): c is Chat => c !== null);
        chats = [...chats, ...newChats];
        unloadedMetas = unloadedMetas.slice(LOAD_MORE_PAGE_SIZE);
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
        searchResults = results;
    }

    function clearSearch() {
        searchResults = null;
        searchQuery = '';
        highlightMessageIndex = null;
    }

    function shouldSaveSettings(): boolean {
        return untrack(() => settingsLoaded) && !untrack(() => demoMode);
    }

    // Immediate save for discrete controls. Sliders get their own debounced
    // path below so drag gestures don't spam extension storage.
    $effect(() => {
        const snapshot: Partial<UserSettings> = {
            theme,
            smoothTextMode,
            submitKeystroke,
            modelTier,
            autoscroll,
            providerId,
            modelId,
            adaptiveThinking,
            tagOpenRouterRequests,
            openRouterFreeModels,
            syncApiKeys,
        };
        if (!shouldSaveSettings()) return;
        console.log(LOG, 'settings save', snapshot);
        saveSettings(snapshot);
    });

    // Debounced save for range-backed controls.
    $effect(() => {
        const snapshot: Partial<UserSettings> = {
            fontSizeIndex,
            chatWidth,
            temperature,
            maxTokens,
            thinkingLevel,
        };
        if (!shouldSaveSettings()) return;
        const timer = setTimeout(() => {
            console.log(LOG, 'settings save (slider debounce)', snapshot);
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
        const demoChats = buildDemoChats({
            providerId,
            modelId,
            temperature,
            maxTokens,
            thinkingLevel,
            adaptiveThinking,
        });
        chats = demoChats;
        unloadedMetas = [];
        activeChatId = demoChats[0].id;
        demoMode = true;
        showExtensionPrompt = false;
        console.log(LOG, 'entered demo mode');
    }

    function requestExtension() {
        showExtensionPrompt = true;
    }

    function hasOpenRouterModels() {
        return (
            providers.find((p) => p.id === 'openrouter')?.models.length ?? 0
        ) > 0;
    }

    function handleApiKeySaved(providerId: string) {
        if (providerId === 'openrouter' && !hasOpenRouterModels()) {
            hydrateOpenRouterModels().catch(console.error);
        }
    }

    function handleApiKeyCleared() {
        // Keep any downloaded OpenRouter catalog available; only the key goes away.
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
        activeChatId = id;
    }

    async function selectChat(id: string, matchIndex?: number | null) {
        highlightMessageIndex = matchIndex ?? null;
        console.log(LOG, 'select chat', id);
        activeChatId = id;

        // Restore model config + system prompt from whichever side has the meta.
        const loaded = chats.find((c) => c.id === id);
        if (loaded) {
            providerId = loaded.providerId;
            modelId = loaded.modelId;
            temperature = loaded.temperature;
            maxTokens = loaded.maxTokens;
            thinkingLevel = loaded.thinkingLevel;
            adaptiveThinking = loaded.adaptiveThinking ?? true;
            systemPrompt = loaded.systemPrompt;
            return;
        }

        const meta = unloadedMetas.find((t) => t.id === id);
        if (!meta) return;
        providerId = meta.providerId;
        modelId = meta.modelId;
        temperature = meta.temperature;
        maxTokens = meta.maxTokens;
        thinkingLevel = meta.thinkingLevel;
        adaptiveThinking = meta.adaptiveThinking ?? true;
        systemPrompt = meta.systemPrompt;

        chatLoading = true;
        const full = await loadChat(id);
        chatLoading = false;

        if (full && activeChatId === id) {
            chats = [
                ...chats,
                {
                    ...meta,
                    messages: full.messages,
                    ...(full.tokens ? { tokens: full.tokens } : {}),
                },
            ];
            unloadedMetas = unloadedMetas.filter((m) => m.id !== id);
        }
    }

    function clearChatError(id: string) {
        if (!chatErrors[id]) return;
        const { [id]: _, ...rest } = chatErrors;
        chatErrors = rest;
    }

    function removeChat(id: string) {
        console.log(LOG, 'remove chat', id);
        streamHandles.get(id)?.abort();
        streamHandles.delete(id);
        chats = chats.filter((c) => c.id !== id);
        unloadedMetas = unloadedMetas.filter((t) => t.id !== id);
        if (activeChatId === id) {
            activeChatId = null;
            systemPrompt = '';
        }
        streamingChatIds = streamingChatIds.filter((sid) => sid !== id);
        clearChatError(id);
        if (!demoMode) deleteChat(id).catch(console.error);
    }

    function renameChat(id: string, newTitle: string) {
        console.log(LOG, 'rename chat', id, newTitle);
        chats = chats.map((c) => (c.id === id ? { ...c, title: newTitle } : c));
        unloadedMetas = unloadedMetas.map((m) =>
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
        if (messages.length === 0) {
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

    // Streams an assistant response into the trailing placeholder of `chatId`.
    // Caller is responsible for prepping the chat: messages must end with an
    // empty assistant message, streamingChatIds must include chatId, and any
    // prior stream for this chat must be aborted.
    //
    // The extension owns persistence end-to-end: it acquires a per-chatId
    // lock, streams, and writes the final StoredChat. The web side only
    // mirrors chunks into local state for live render.
    function streamForChat(chatId: string) {
        const snap = chats.find((c) => c.id === chatId);
        if (!snap) return;

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

        // What the extension persists at end-of-turn (no system prompt, no
        // empty placeholder, with thinking preserved).
        const historyForSave: StoredChat['messages'] = snap.messages
            .slice(0, -1)
            .map(({ role, content, thinking, attachments }) => ({
                role,
                content,
                ...(thinking ? { thinking } : {}),
                ...(attachments ? { attachments } : {}),
            }));

        const modelParams = providers.find(
            (p) => p.id === snap.providerId,
        )?.models.find((m) => m.id === snap.modelId)?.params;

        const updateLast = (mutate: (last: Message) => Message) => {
            chats = chats.map((c) => {
                if (c.id !== chatId) return c;
                const msgs = [...c.messages];
                msgs[msgs.length - 1] = mutate(msgs[msgs.length - 1]);
                return { ...c, messages: msgs };
            });
        };

        const finishStream = () => {
            streamHandles.delete(chatId);
            streamingChatIds = streamingChatIds.filter((id) => id !== chatId);
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
                    tagOpenRouterRequests,
                },
                meta: chatToMeta(snap),
                historyForSave,
            },
            {
                onChunk: (chunk) => {
                    updateLast((last) => ({
                        ...last,
                        content: last.content + chunk,
                    }));
                },
                onThinking: (chunk) => {
                    updateLast((last) => ({
                        ...last,
                        thinking: (last.thinking ?? '') + chunk,
                    }));
                },
                onDone: (usage) => {
                    finishStream();
                    if (usage) {
                        chats = chats.map((c) =>
                            c.id === chatId
                                ? {
                                      ...c,
                                      tokens: {
                                          input: usage.inputTokens,
                                          output: usage.outputTokens,
                                      },
                                  }
                                : c,
                        );
                    }
                },
                onError: (msg) => {
                    finishStream();
                    chatErrors = {
                        ...chatErrors,
                        [chatId]: `API Error: ${msg}`,
                    };
                    // Discard the placeholder only if no content arrived —
                    // keep partial content otherwise.
                    chats = chats.map((c) => {
                        if (c.id !== chatId) return c;
                        const last = c.messages[c.messages.length - 1];
                        return last?.content
                            ? c
                            : { ...c, messages: c.messages.slice(0, -1) };
                    });
                },
            },
        );
        streamHandles.set(chatId, handle);
    }

    // --- Cross-tab broadcast handlers ---
    //
    // When another tab streams a turn, the extension fans out lifecycle
    // events to every connected tab. We mirror those into local state so the
    // sidebar spinner and same-chat live-render work without any tab needing
    // to poll. The originating tab ignores its own turn-start (sourceTabId
    // matches our tabId); the source tab's turn port already feeds it chunks.

    function applyRemoteTurnStart(
        chatId: string,
        meta: ChatMeta,
        history: StoredChat['messages'],
    ) {
        // The source tab's local streamingChatIds already contains chatId by
        // the time turn-start arrives — but we filter on sourceTabId at the
        // event boundary, so by the time we reach here we know it's remote.
        const placeholder: Message = { role: 'assistant', content: '' };
        const existing = chats.find((c) => c.id === chatId);
        if (existing) {
            chats = chats.map((c) =>
                c.id === chatId
                    ? { ...c, messages: [...history, placeholder] }
                    : c,
            );
        } else {
            const fromUnloaded = unloadedMetas.find((m) => m.id === chatId);
            const newChat: Chat = {
                ...meta,
                messages: [...history, placeholder],
            };
            chats = [newChat, ...chats];
            if (fromUnloaded) {
                unloadedMetas = unloadedMetas.filter((m) => m.id !== chatId);
            }
        }
        if (!remoteStreamingChatIds.includes(chatId)) {
            remoteStreamingChatIds = [...remoteStreamingChatIds, chatId];
        }
        clearChatError(chatId);
    }

    function applyRemoteTurnChunk(
        chatId: string,
        kind: 'content' | 'thinking',
        delta: string,
    ) {
        if (!remoteStreamingChatIds.includes(chatId)) return;
        chats = chats.map((c) => {
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

    async function applyRemoteTurnDone(chatId: string) {
        if (!remoteStreamingChatIds.includes(chatId)) return;
        remoteStreamingChatIds = remoteStreamingChatIds.filter(
            (id) => id !== chatId,
        );
        // Refresh from IDB for canonical state — the extension just saved.
        const stored = await loadChat(chatId);
        if (stored) {
            chats = chats.map((c) =>
                c.id === chatId
                    ? {
                          ...c,
                          messages: stored.messages,
                          ...(stored.tokens ? { tokens: stored.tokens } : {}),
                      }
                    : c,
            );
        }
    }

    async function applyRemoteTurnAborted(chatId: string) {
        if (!remoteStreamingChatIds.includes(chatId)) return;
        remoteStreamingChatIds = remoteStreamingChatIds.filter(
            (id) => id !== chatId,
        );
        // Source tab bailed without saving. IDB has the pre-turn state (or
        // nothing if this was the chat's very first turn).
        const stored = await loadChat(chatId);
        if (stored) {
            chats = chats.map((c) =>
                c.id === chatId
                    ? { ...c, messages: stored.messages }
                    : c,
            );
        } else {
            chats = chats.filter((c) => c.id !== chatId);
            if (activeChatId === chatId) activeChatId = null;
        }
    }

    async function applyRemoteTurnError(chatId: string, message: string) {
        if (!remoteStreamingChatIds.includes(chatId)) return;
        remoteStreamingChatIds = remoteStreamingChatIds.filter(
            (id) => id !== chatId,
        );
        chatErrors = { ...chatErrors, [chatId]: `API Error: ${message}` };
        const stored = await loadChat(chatId);
        if (stored) {
            chats = chats.map((c) =>
                c.id === chatId
                    ? {
                          ...c,
                          messages: stored.messages,
                          ...(stored.tokens ? { tokens: stored.tokens } : {}),
                      }
                    : c,
            );
        }
    }

    function handleBroadcastEvent(event: BroadcastEvent) {
        switch (event.type) {
            case 'turn-start':
                if (event.sourceTabId === tabId) return;
                applyRemoteTurnStart(event.chatId, event.meta, event.history);
                return;
            case 'turn-chunk':
                applyRemoteTurnChunk(event.chatId, event.kind, event.delta);
                return;
            case 'turn-done':
                applyRemoteTurnDone(event.chatId);
                return;
            case 'turn-error':
                applyRemoteTurnError(event.chatId, event.message);
                return;
            case 'turn-aborted':
                applyRemoteTurnAborted(event.chatId);
                return;
        }
    }

    async function handleBroadcastReconnect() {
        // The broadcast port reconnected (e.g. service worker came back from
        // eviction). We may have missed events — at minimum, refresh the
        // active chat from IDB so the user sees canonical state.
        if (!activeChatId) return;
        const stored = await loadChat(activeChatId);
        if (!stored) return;
        chats = chats.map((c) =>
            c.id === activeChatId
                ? {
                      ...c,
                      messages: stored.messages,
                      ...(stored.tokens ? { tokens: stored.tokens } : {}),
                  }
                : c,
        );
    }

    onMount(() => {
        const sub = subscribeToBroadcast({
            onEvent: handleBroadcastEvent,
            onReconnect: handleBroadcastReconnect,
        });
        return () => sub.unsubscribe();
    });

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
        }

        const userMsg: Message = {
            role: 'user',
            content,
            ...(attachments?.length ? { attachments } : {}),
        };
        chats = chats.map((c) =>
            c.id === chatId
                ? {
                      ...c,
                      messages: [
                          ...c.messages,
                          userMsg,
                          { role: 'assistant', content: '' },
                      ],
                  }
                : c,
        );

        streamingChatIds = [...streamingChatIds, chatId];
        clearChatError(chatId);
        streamForChat(chatId);
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
        streamHandles.get(chatId)?.abort();
        streamHandles.delete(chatId);
        streamingChatIds = streamingChatIds.filter((id) => id !== chatId);

        // If assistant message, treat as retrying the user message above it
        const msg = chat.messages[index];
        if (!msg) return;
        const keepUpTo = msg.role === 'user' ? index : index - 1;
        if (keepUpTo < 0) return;

        chats = chats.map((c) =>
            c.id === chatId
                ? {
                      ...c,
                      systemPrompt,
                      providerId,
                      modelId,
                      temperature,
                      maxTokens,
                      thinkingLevel,
                      adaptiveThinking,
                      messages: [
                          ...c.messages.slice(0, keepUpTo + 1),
                          { role: 'assistant', content: '' },
                      ],
                  }
                : c,
        );

        clearChatError(chatId);
        streamingChatIds = [...streamingChatIds, chatId];
        streamForChat(chatId);
    }

    // Graceful stop. ChatPanel passes the currently-visible (smoothed) text
    // so we save exactly what the user saw — any queued-but-not-drained
    // characters are discarded. Empty stop discards the assistant turn entirely.
    function stopMessage(truncated: string) {
        if (!activeChatId) return;
        const chatId = activeChatId;
        const handle = streamHandles.get(chatId);
        if (!handle) return;

        handle.stop(truncated);
        streamHandles.delete(chatId);
        streamingChatIds = streamingChatIds.filter((id) => id !== chatId);

        chats = chats.map((c) => {
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
    <ExtensionPrompt variant={promptVariant} onlookaround={enterDemoMode} />
{/if}

<div class="app">
    <Sidebar
        {chats}
        {activeChatId}
        {hasMoreChats}
        {isLoadingMore}
        streamingChatIds={allStreamingChatIds}
        {chatErrors}
        {searchResults}
        {searchQuery}
        {demoMode}
        {initialized}
        bind:theme
        bind:fontSizeIndex
        bind:chatWidth
        bind:smoothTextMode
        bind:submitKeystroke
        bind:modelTier
        bind:autoscroll
        bind:tagOpenRouterRequests
        bind:openRouterFreeModels
        bind:syncApiKeys
        onnewchat={newChat}
        onselectchat={selectChat}
        ondeletechat={removeChat}
        onrenamechat={renameChat}
        onexportchat={exportChat}
        onloadmore={loadMoreChats}
        onsearch={search}
        onclearsearch={clearSearch}
        onextensionneeded={requestExtension}
        onapikeysaved={handleApiKeySaved}
        onapikeycleared={handleApiKeyCleared}
    />
    <ChatPanel
        messages={activeMessages}
        isStreaming={isActiveStreaming}
        streamingLocally={isActiveLocalStreaming}
        streamError={activeStreamError}
        {chatWidth}
        {smoothTextMode}
        {submitKeystroke}
        {autoscroll}
        loading={chatLoading}
        bind:systemPrompt
        {highlightMessageIndex}
        {demoMode}
        onsend={sendMessage}
        onstop={stopMessage}
        onretry={retryMessage}
        onedit={editMessage}
        ondelete={deleteMessage}
        onextensionneeded={requestExtension}
    />
    <ModelConfig
        {providers}
        {modelTier}
        {initialized}
        {openRouterFreeModels}
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
