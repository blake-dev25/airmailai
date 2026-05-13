import type {
    BroadcastEvent,
    BroadcastRequest,
    ChatMeta,
    ExtensionResponse,
    OpenRouterModel,
    StorageRequest,
    StorageResponse,
    StoredChat,
    StreamHandlers,
    TurnStartRequest,
    UserSettings,
} from '@courier/shared';

export interface StreamHandle {
    // Hard cancel: disconnect immediately, no save.
    abort: () => void;
    // Graceful stop: save with truncated visible content, then disconnect.
    stop: (truncatedContent: string) => void;
}

// Stable per-tab identifier. Generated once per page load; broadcasted in
// turn-start so the originating tab can ignore its own echo.
export const tabId = crypto.randomUUID();

const LOG = '[courier:web]';
// Cadence for the broadcast-port heartbeat. Comfortably inside Chrome's 30s
// SW idle timer so any tab being open keeps the worker warm — no separate
// per-stream keepalive needed.
const KEEPALIVE_MS = 20_000;

// The content script runs at document_start and writes
// `document.documentElement.dataset.courieraiExtId` before any page script
// runs. Reading it synchronously at module load gives us a CPU-throttle-proof
// presence check — no message round-trip required.
//
// TODO: once the extension is published with a static ID, verify the dataset
// value matches the expected ID before trusting it — defends against another
// installed extension impersonating ours by writing the same dataset key.
let extensionId: string | null =
    document.documentElement.dataset.courieraiExtId ?? null;
if (extensionId) console.log(LOG, 'extension ID from DOM marker', extensionId);

// Still listen for postMessage as a fallback (e.g. content script re-announces).
window.addEventListener('message', (e: MessageEvent) => {
    if (e.data?.type === 'COURIER_EXT_READY' && typeof e.data.id === 'string') {
        extensionId = e.data.id;
        console.log(LOG, 'extension ID received', extensionId);
    }
});

export function isExtensionReady(): boolean {
    return extensionId !== null;
}

// Synchronous because the document_start content script guarantees the DOM
// marker is set before this module ever runs. If it's not there, the
// extension isn't installed.
export function waitForExtension(): Promise<boolean> {
    return Promise.resolve(extensionId !== null);
}

async function sendStorageMessage(
    request: StorageRequest
): Promise<StorageResponse> {
    if (!extensionId) {
        console.error(
            LOG,
            'storage: extension not detected, cannot send',
            request.type
        );
        return { type: 'error', message: 'Extension not detected.' };
    }
    console.log(LOG, '→ storage', request.type);
    return new Promise((resolve) => {
        chrome.runtime.sendMessage(
            extensionId as string,
            request,
            (response: StorageResponse) => {
                const result = response ?? {
                    type: 'error',
                    message: 'No response from extension.',
                };
                if (result.type === 'error') {
                    console.error(LOG, '← storage error', result.message);
                } else {
                    console.log(LOG, '← storage', result.type);
                }
                resolve(result);
            }
        );
    });
}

export async function saveApiKey(
    provider: string,
    apiKey: string,
    syncApiKeys: boolean
): Promise<boolean> {
    const response = await sendStorageMessage({
        type: 'save_key',
        provider,
        apiKey,
        syncApiKeys,
    });
    return response.type === 'saved';
}

export async function clearApiKey(provider: string): Promise<boolean> {
    const response = await sendStorageMessage({ type: 'clear_key', provider });
    return response.type === 'saved';
}

export async function checkApiKeys(
    providers: string[]
): Promise<Record<string, boolean>> {
    const response = await sendStorageMessage({ type: 'has_keys', providers });
    if (response.type === 'has_keys') return response.saved;
    return Object.fromEntries(providers.map((p) => [p, false]));
}

export async function saveSettings(
    settings: Partial<UserSettings>
): Promise<void> {
    await sendStorageMessage({ type: 'save_settings', settings });
}

export async function loadSettings(): Promise<Partial<UserSettings>> {
    const response = await sendStorageMessage({ type: 'load_settings' });
    if (response.type === 'settings') return response.settings;
    return {};
}

export async function saveChat(
    chat: StoredChat,
    meta: ChatMeta
): Promise<void> {
    await sendStorageMessage({ type: 'save_chat', chat, meta });
}

export async function deleteChat(chatId: string): Promise<void> {
    await sendStorageMessage({ type: 'delete_chat', chatId });
}

export async function loadChatMetas(): Promise<ChatMeta[]> {
    const response = await sendStorageMessage({ type: 'load_chat_metas' });
    if (response.type === 'chat_metas') return response.metas;
    return [];
}

export async function loadChatsByIds(ids: string[]): Promise<StoredChat[]> {
    const response = await sendStorageMessage({
        type: 'load_chats_by_ids',
        ids,
    });
    if (response.type === 'chats') return response.chats;
    return [];
}

export async function loadChat(chatId: string): Promise<StoredChat | null> {
    const response = await sendStorageMessage({ type: 'load_chat', chatId });
    if (response.type === 'chat') return response.chat;
    return null;
}

export async function loadOpenRouterModels(): Promise<
    OpenRouterModel[] | null
> {
    const response = await sendStorageMessage({
        type: 'load_openrouter_models',
    });
    if (response.type === 'openrouter_models') return response.models;
    return null;
}

export function sendToExtension(
    request: Omit<TurnStartRequest, 'type'>,
    handlers: StreamHandlers
): StreamHandle {
    if (!extensionId) {
        console.error(LOG, 'chat: extension not detected');
        handlers.onError(
            'CourierAI extension not detected. Install it and refresh to start chatting.'
        );
        return { abort: () => {}, stop: () => {} };
    }

    console.log(LOG, '→ chat request', {
        chatId: request.chatId,
        provider: request.provider,
        model: request.model,
        messages: request.messages.length,
        params: request.params,
    });

    let done = false;
    let stopped = false;
    let aborted = false;
    let firstChunk = true;
    const port = chrome.runtime.connect(extensionId);

    port.onMessage.addListener((response: ExtensionResponse) => {
        switch (response.type) {
            case 'chunk':
                if (stopped) break;
                if (firstChunk) {
                    console.log(LOG, '← first chunk received');
                    firstChunk = false;
                }
                handlers.onChunk(response.content);
                break;
            case 'thinking_chunk':
                if (stopped) break;
                handlers.onThinking?.(response.content);
                break;
            case 'done':
                done = true;
                console.log(LOG, '← stream done');
                handlers.onDone(response.usage);
                port.disconnect();
                break;
            case 'error':
                done = true;
                console.error(LOG, '← stream error', response.message);
                handlers.onError(response.message, 'api');
                port.disconnect();
                break;
        }
    });

    port.onDisconnect.addListener(() => {
        if (!done && !aborted) {
            done = true;
            const msg =
                chrome.runtime.lastError?.message ??
                'Extension disconnected unexpectedly.';
            console.error(LOG, '✗ unexpected port disconnect', msg);
            handlers.onError(msg, 'extension');
        }
    });

    port.postMessage({ type: 'start', ...request });

    return {
        abort: () => {
            if (!done) {
                aborted = true;
                port.disconnect();
            }
        },
        stop: (truncatedContent: string) => {
            if (done || stopped) return;
            stopped = true;
            port.postMessage({ type: 'stop', truncatedContent });
        },
    };
}

// Long-lived subscription to cross-tab turn lifecycle events. The extension
// broadcasts turn-start/chunk/done/error/aborted to every tab; subscribers
// route them into local state. The port auto-reconnects after disconnects
// (e.g. service worker eviction); on reconnect, onReconnect fires so callers
// can resync the active chat from IDB.
export interface BroadcastSubscription {
    unsubscribe: () => void;
}

export function subscribeToBroadcast(handlers: {
    onEvent: (event: BroadcastEvent) => void;
    onReconnect?: () => void;
}): BroadcastSubscription {
    let port: chrome.runtime.Port | null = null;
    let unsubscribed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
    let everConnected = false;

    const clearKeepalive = () => {
        if (keepaliveTimer === null) return;
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
    };

    function connect() {
        if (unsubscribed) return;
        if (!extensionId) {
            // Extension not detected yet — try again shortly.
            reconnectTimer = setTimeout(connect, 1000);
            return;
        }
        try {
            port = chrome.runtime.connect(extensionId, { name: 'broadcast' });
        } catch (err) {
            console.error(LOG, 'broadcast: connect failed', err);
            reconnectTimer = setTimeout(connect, 1000);
            return;
        }
        console.log(LOG, 'broadcast: connected');

        if (everConnected) handlers.onReconnect?.();
        everConnected = true;

        port.onMessage.addListener((event: BroadcastEvent) => {
            handlers.onEvent(event);
        });

        port.onDisconnect.addListener(() => {
            console.log(LOG, 'broadcast: disconnected, reconnecting in 1s');
            port = null;
            clearKeepalive();
            if (!unsubscribed) reconnectTimer = setTimeout(connect, 1000);
        });

        // Heartbeat: keeps the SW's 30s idle timer reset for as long as this
        // tab is open, so storage ops and new turns hit a warm worker.
        keepaliveTimer = setInterval(() => {
            if (!port) return;
            try {
                const msg: BroadcastRequest = { type: 'keepalive' };
                port.postMessage(msg);
            } catch (err) {
                console.warn(LOG, 'broadcast keepalive failed', err);
                clearKeepalive();
            }
        }, KEEPALIVE_MS);
    }

    connect();

    return {
        unsubscribe: () => {
            unsubscribed = true;
            if (reconnectTimer !== null) clearTimeout(reconnectTimer);
            clearKeepalive();
            if (port) port.disconnect();
        },
    };
}
