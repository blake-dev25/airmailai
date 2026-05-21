import { readUIMessageStream } from 'ai';
import type {
    BroadcastEvent,
    BroadcastRequest,
    ChatMeta,
    CourierUIMessage,
    CourierUIMessageChunk,
    ExtensionStreamEvent,
    HydratedStoredMessage,
    OpenRouterModel,
    StorageRequest,
    StorageResponse,
    StorageUsage,
    StoredChat,
    StreamErrorSource,
    TurnStartRequest,
    UserSettings,
} from '@courier/shared';

export interface StreamHandlers {
    // Fires every time the streamed UIMessage grows. The argument is the
    // full reassembled message (placeholder id, role 'assistant', parts).
    onMessage: (message: CourierUIMessage) => void;
    // Terminal success — the ext has saved the row. No usage payload here
    // because tokens land via message-metadata chunks, surfaced through
    // onMessage.
    onDone: () => void;
    onError: (message: string, source: StreamErrorSource) => void;
}

export interface StreamHandle {
    // Hard cancel: disconnect immediately, no save.
    abort: () => void;
    // Graceful stop: ext aborts the underlying stream and saves the partial
    // UIMessage assembled by AI SDK's onFinish.
    stop: () => void;
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

// Throws if the extension isn't reachable or returns an error response. Every
// caller is expected to either await + .catch, or rely on the storage helpers
// below — which all surface errors loudly rather than swallowing them.
async function sendStorageMessage(
    request: StorageRequest
): Promise<StorageResponse> {
    if (!extensionId) {
        console.error(
            LOG,
            'storage: extension not detected, cannot send',
            request.type
        );
        throw new Error('Extension not detected.');
    }
    console.log(LOG, '→ storage', request.type);
    const response = await new Promise<StorageResponse | undefined>(
        (resolve) => {
            chrome.runtime.sendMessage(
                extensionId as string,
                request,
                (resp: StorageResponse) => resolve(resp)
            );
        }
    );
    if (!response) {
        console.error(LOG, '← storage: no response', request.type);
        throw new Error(
            `Extension didn't respond to ${request.type}. It may have been disabled or updated.`
        );
    }
    if (response.type === 'error') {
        console.error(LOG, '← storage error', response.message);
        throw new Error(response.message);
    }
    console.log(LOG, '← storage', response.type);
    return response;
}

export async function saveApiKey(
    provider: string,
    apiKey: string,
    syncApiKeys: boolean
): Promise<void> {
    await sendStorageMessage({
        type: 'save_key',
        provider,
        apiKey,
        syncApiKeys,
    });
}

export async function clearApiKey(provider: string): Promise<void> {
    await sendStorageMessage({ type: 'clear_key', provider });
}

export async function checkApiKeys(
    providers: string[]
): Promise<Record<string, boolean>> {
    const response = await sendStorageMessage({ type: 'has_keys', providers });
    if (response.type === 'has_keys') return response.saved;
    throw new Error(`Unexpected response: ${response.type}`);
}

export async function saveSettings(
    settings: Partial<UserSettings>
): Promise<void> {
    await sendStorageMessage({ type: 'save_settings', settings });
}

export async function loadSettings(): Promise<Partial<UserSettings>> {
    const response = await sendStorageMessage({ type: 'load_settings' });
    if (response.type === 'settings') return response.settings;
    throw new Error(`Unexpected response: ${response.type}`);
}

export async function saveMeta(meta: ChatMeta): Promise<void> {
    await sendStorageMessage({ type: 'save_meta', meta });
}

export async function putMessage(
    message: HydratedStoredMessage
): Promise<void> {
    await sendStorageMessage({ type: 'put_message', message });
}

export async function deleteMessage(
    chatId: string,
    messageId: string
): Promise<void> {
    await sendStorageMessage({ type: 'delete_message', chatId, messageId });
}

export async function deleteMessagesAfter(
    chatId: string,
    lastKeptId: string
): Promise<void> {
    await sendStorageMessage({
        type: 'delete_messages_after',
        chatId,
        lastKeptId,
    });
}

export async function deleteChat(chatId: string): Promise<void> {
    await sendStorageMessage({ type: 'delete_chat', chatId });
}

export async function loadChatMetas(): Promise<ChatMeta[]> {
    const response = await sendStorageMessage({ type: 'load_chat_metas' });
    if (response.type === 'chat_metas') return response.metas;
    throw new Error(`Unexpected response: ${response.type}`);
}

export async function loadChatsByIds(ids: string[]): Promise<StoredChat[]> {
    const response = await sendStorageMessage({
        type: 'load_chats_by_ids',
        ids,
    });
    if (response.type === 'chats') return response.chats;
    throw new Error(`Unexpected response: ${response.type}`);
}

export async function loadChat(chatId: string): Promise<StoredChat | null> {
    const response = await sendStorageMessage({ type: 'load_chat', chatId });
    if (response.type === 'chat') return response.chat;
    throw new Error(`Unexpected response: ${response.type}`);
}

// Returns null when there's no API key + no cache (legitimate empty state).
// Throws on fetch failure — caller surfaces via setAppError.
export async function loadOpenRouterModels(): Promise<
    OpenRouterModel[] | null
> {
    const response = await sendStorageMessage({
        type: 'load_openrouter_models',
    });
    if (response.type === 'openrouter_models') return response.models;
    throw new Error(`Unexpected response: ${response.type}`);
}

export async function getStorageUsage(): Promise<StorageUsage> {
    const response = await sendStorageMessage({ type: 'get_storage_usage' });
    if (response.type === 'storage_usage') {
        const { type: _t, ...usage } = response;
        return usage;
    }
    throw new Error(`Unexpected response: ${response.type}`);
}

export async function clearAllChats(): Promise<void> {
    await sendStorageMessage({ type: 'clear_chats' });
}

export async function clearAllStorage(): Promise<void> {
    await sendStorageMessage({ type: 'clear_all' });
}

// Wraps a port-based turn stream. Chunks from the ext are fed into AI SDK's
// `readUIMessageStream`, which rebuilds the full UIMessage as parts arrive
// — we hand the rebuilt message to the caller via `onMessage` and let it
// replace its placeholder in-place. No bespoke chunk accumulator needed.
export function sendToExtension(
    request: Omit<TurnStartRequest, 'type'>,
    handlers: StreamHandlers
): StreamHandle {
    if (!extensionId) {
        console.error(LOG, 'chat: extension not detected');
        handlers.onError(
            'CourierAI extension not detected. Install it and refresh to start chatting.',
            'extension'
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
    let aborted = false;
    let stopped = false;
    const port = chrome.runtime.connect(extensionId);

    // Bridge port → ReadableStream → readUIMessageStream → onMessage. We
    // close the stream on 'done' / 'error' so readUIMessageStream exits its
    // for-await loop cleanly.
    let chunkController: ReadableStreamDefaultController<CourierUIMessageChunk> | null =
        null;
    const chunkStream = new ReadableStream<CourierUIMessageChunk>({
        start(controller) {
            chunkController = controller;
        },
    });

    // Seed with an empty placeholder so readUIMessageStream has a base to
    // accumulate into. The id matches the assistant placeholder the web
    // pre-rendered; metadata.createdAt is "now" until the ext sends its
    // own message-metadata.
    const placeholder: CourierUIMessage = {
        id: request.assistantMessageId,
        role: 'assistant',
        parts: [],
        metadata: { createdAt: Date.now() },
    };

    (async () => {
        try {
            for await (const msg of readUIMessageStream<CourierUIMessage>({
                message: placeholder,
                stream: chunkStream,
                onError: (e) => {
                    console.error(LOG, 'readUIMessageStream onError', e);
                },
            })) {
                handlers.onMessage(msg);
            }
        } catch (e) {
            console.error(LOG, 'UI stream loop threw', e);
        }
    })();

    port.onMessage.addListener((event: ExtensionStreamEvent) => {
        switch (event.type) {
            case 'chunk':
                if (stopped) break;
                chunkController?.enqueue(event.chunk);
                break;
            case 'done': {
                done = true;
                chunkController?.close();
                chunkController = null;
                handlers.onDone();
                port.disconnect();
                break;
            }
            case 'error':
                done = true;
                console.error(
                    LOG,
                    '← stream error',
                    event.source,
                    event.message
                );
                chunkController?.close();
                chunkController = null;
                handlers.onError(event.message, event.source);
                port.disconnect();
                break;
        }
    });

    port.onDisconnect.addListener(() => {
        if (!done && !aborted) {
            done = true;
            chunkController?.close();
            chunkController = null;
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
                chunkController?.close();
                chunkController = null;
                port.disconnect();
            }
        },
        stop: () => {
            if (done || stopped) return;
            stopped = true;
            port.postMessage({ type: 'stop' });
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

    const clearReconnect = () => {
        if (reconnectTimer === null) return;
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    };

    function connect() {
        if (unsubscribed) return;
        clearReconnect();
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
            // Read lastError to consume any close reason Chrome attached
            // (e.g. bfcache eviction). Without this, Chrome surfaces it as
            // "Unchecked runtime.lastError".
            const reason = chrome.runtime.lastError?.message;
            console.log(
                LOG,
                'broadcast: disconnected, reconnecting in 1s',
                reason ? `(${reason})` : ''
            );
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

    // BFCache handling: Chrome closes the port channel when the page enters
    // bfcache (Chrome 123+). pagehide+persisted means we're freezing — drop
    // the dead reference so the post-restore keepalive can't fire on it.
    // pageshow+persisted means we just thawed; reconnect immediately rather
    // than waiting for the disconnect-driven 1s backoff.
    const onPageHide = (event: PageTransitionEvent) => {
        if (!event.persisted) return;
        console.log(LOG, 'broadcast: page entering bfcache, releasing port');
        clearKeepalive();
        clearReconnect();
        port = null;
    };
    const onPageShow = (event: PageTransitionEvent) => {
        if (!event.persisted) return;
        console.log(LOG, 'broadcast: page restored from bfcache, reconnecting');
        connect();
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);

    connect();

    return {
        unsubscribe: () => {
            unsubscribed = true;
            window.removeEventListener('pagehide', onPageHide);
            window.removeEventListener('pageshow', onPageShow);
            clearReconnect();
            clearKeepalive();
            if (port) port.disconnect();
        },
    };
}
