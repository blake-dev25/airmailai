import type {
    BroadcastEvent,
    BroadcastRequest,
    ChatMeta,
    CourierAIChunk,
    DraftAttachment,
    ExtensionStreamEvent,
    FileAvailability,
    FileDeleteTarget,
    HydratedStoredMessage,
    LocalFileInfo,
    OpenRouterModel,
    ProviderFileInfo,
    StorageRequest,
    StorageResponse,
    StorageUsage,
    StoredChat,
    StreamErrorSource,
    TurnStartRequest,
    UserSettings,
} from '@courierai/shared';

export interface StreamHandlers {
    onChunk: (chunk: CourierAIChunk) => void;
    onDone: () => void;
    onError: (message: string, source: StreamErrorSource) => void;
}

export interface StreamHandle {
    abort: () => void;
    stop: (truncateTo: number) => void;
}

export const tabId = crypto.randomUUID();

import { log } from './log';
const KEEPALIVE_MS = 20_000;

let extensionId: string | null =
    document.documentElement.dataset.courieraiExtId ?? null;
if (extensionId) log.info('extension ID from DOM marker', extensionId);

window.addEventListener('message', (e: MessageEvent) => {
    if (
        e.data?.type === 'COURIERAI_EXT_READY' &&
        typeof e.data.id === 'string'
    ) {
        extensionId = e.data.id;
        log.info('extension ID received', extensionId);
    }
});

const DETECT_TIMEOUT_MS = 1500;
const DETECT_PING_INTERVAL_MS = 150;

// *** TODO(static-id): once the extension is published to the Chrome Web Store its
// ID is static. Replace this READY/PING handshake with a hardcoded extension
// ID + direct chrome.runtime.sendMessage probe (which also wakes the service
// worker), and delete the extension's content script.
export function waitForExtension(): Promise<boolean> {
    if (extensionId) return Promise.resolve(true);
    return new Promise((resolve) => {
        const deadline = Date.now() + DETECT_TIMEOUT_MS;
        const tick = () => {
            const marker = document.documentElement.dataset.courieraiExtId;
            if (marker) extensionId = marker;
            if (extensionId) {
                resolve(true);
                return;
            }
            if (Date.now() >= deadline) {
                resolve(false);
                return;
            }
            window.postMessage({ type: 'COURIERAI_EXT_PING' }, '*');
            setTimeout(tick, DETECT_PING_INTERVAL_MS);
        };
        tick();
    });
}

async function sendStorageMessage(
    request: StorageRequest
): Promise<StorageResponse> {
    if (!extensionId) {
        log.error('storage: extension not detected, cannot send', request.type);
        throw new Error('Extension not detected.');
    }
    log.info('-> storage', request.type);
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
        log.error('<- storage: no response', request.type);
        throw new Error(
            `Extension didn't respond to ${request.type}. It may have been disabled or updated.`
        );
    }
    if (response.type === 'error') {
        log.error('<- storage error', response.message);
        throw new Error(response.message);
    }
    log.info('<- storage', response.type);
    return response;
}

export async function saveApiKey(
    provider: string,
    apiKey: string
): Promise<void> {
    await sendStorageMessage({ type: 'save_key', provider, apiKey });
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
    await sendStorageMessage({ type: 'save_meta', meta, sourceTabId: tabId });
}

export async function putMessage(
    message: HydratedStoredMessage
): Promise<void> {
    await sendStorageMessage({ type: 'put_message', message });
}

export async function stageDraftAttachment(
    chatId: string,
    attachment: DraftAttachment,
    base64: string,
    replicateTo?: string
): Promise<string | undefined> {
    const response = await sendStorageMessage({
        type: 'stage_draft_attachment',
        chatId,
        attachment,
        base64,
        ...(replicateTo ? { replicateTo } : {}),
    });
    if (response.type === 'saved') return response.warning;
    throw new Error(`Unexpected response: ${response.type}`);
}

export async function removeDraftAttachment(
    chatId: string,
    key: string
): Promise<void> {
    await sendStorageMessage({ type: 'remove_draft_attachment', chatId, key });
}

export async function clearDraftAttachments(chatId: string): Promise<void> {
    await sendStorageMessage({ type: 'clear_draft_attachments', chatId });
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
    await sendStorageMessage({
        type: 'delete_chat',
        chatId,
        sourceTabId: tabId,
    });
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

export async function loadOpenRouterModels(): Promise<
    OpenRouterModel[] | null
> {
    const response = await sendStorageMessage({
        type: 'load_openrouter_models',
    });
    if (response.type === 'openrouter_models') return response.models;
    throw new Error(`Unexpected response: ${response.type}`);
}

export async function getFileBlob(
    hash: string
): Promise<{ mediaType: string; base64: string } | null> {
    const response = await sendStorageMessage({ type: 'get_file_blob', hash });
    if (response.type === 'file_blob') return response.blob;
    throw new Error(`Unexpected response: ${response.type}`);
}

export async function getFileStatuses(
    hashes: string[],
    provider: string
): Promise<Record<string, FileAvailability>> {
    const response = await sendStorageMessage({
        type: 'file_status',
        hashes,
        provider,
    });
    if (response.type === 'file_status') return response.statuses;
    throw new Error(`Unexpected response: ${response.type}`);
}

export async function listLocalFiles(): Promise<LocalFileInfo[]> {
    const response = await sendStorageMessage({ type: 'list_local_files' });
    if (response.type === 'local_files') return response.files;
    throw new Error(`Unexpected response: ${response.type}`);
}

export async function listProviderFiles(
    provider: string
): Promise<ProviderFileInfo[]> {
    const response = await sendStorageMessage({
        type: 'list_provider_files',
        provider,
    });
    if (response.type === 'provider_files') return response.files;
    throw new Error(`Unexpected response: ${response.type}`);
}

export async function deleteStoredFile(
    target: FileDeleteTarget
): Promise<string[]> {
    const response = await sendStorageMessage({
        type: 'delete_stored_file',
        target,
        sourceTabId: tabId,
    });
    if (response.type === 'stored_file_deleted') return response.chatIds;
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
    await sendStorageMessage({ type: 'clear_chats', sourceTabId: tabId });
}

export async function clearAllStorage(): Promise<void> {
    await sendStorageMessage({ type: 'clear_all', sourceTabId: tabId });
}

export function sendToExtension(
    request: Omit<TurnStartRequest, 'type'>,
    handlers: StreamHandlers
): StreamHandle {
    if (!extensionId) {
        log.error('chat: extension not detected');
        handlers.onError(
            'CourierAI extension not detected. Install it and refresh to start chatting.',
            'extension'
        );
        return { abort: () => {}, stop: () => {} };
    }

    log.info('-> chat request', {
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

    port.onMessage.addListener((event: ExtensionStreamEvent) => {
        switch (event.type) {
            case 'chunk':
                if (stopped) break;
                handlers.onChunk(event.chunk);
                break;
            case 'done': {
                done = true;
                handlers.onDone();
                port.disconnect();
                break;
            }
            case 'error':
                done = true;
                log.error('<- stream error', event.source, event.message);
                handlers.onError(event.message, event.source);
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
            log.error('X unexpected port disconnect', msg);
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
        stop: (truncateTo: number) => {
            if (done || stopped) return;
            stopped = true;
            port.postMessage({ type: 'stop', truncateTo });
        },
    };
}

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
            reconnectTimer = setTimeout(connect, 1000);
            return;
        }
        try {
            port = chrome.runtime.connect(extensionId, { name: 'broadcast' });
        } catch (err) {
            log.error('broadcast: connect failed', err);
            reconnectTimer = setTimeout(connect, 1000);
            return;
        }
        log.info('broadcast: connected');

        try {
            const msg: BroadcastRequest = {
                type: 'register',
                sourceTabId: tabId,
            };
            port.postMessage(msg);
        } catch (err) {
            log.warn('broadcast register failed', err);
        }

        if (everConnected) handlers.onReconnect?.();
        everConnected = true;

        port.onMessage.addListener((event: BroadcastEvent) => {
            handlers.onEvent(event);
        });

        port.onDisconnect.addListener(() => {
            const reason = chrome.runtime.lastError?.message;
            log.info(
                'broadcast: disconnected, reconnecting in 1s',
                reason ? `(${reason})` : ''
            );
            port = null;
            clearKeepalive();
            if (!unsubscribed) reconnectTimer = setTimeout(connect, 1000);
        });

        keepaliveTimer = setInterval(() => {
            if (!port) return;
            try {
                const msg: BroadcastRequest = { type: 'keepalive' };
                port.postMessage(msg);
            } catch (err) {
                log.warn('broadcast keepalive failed', err);
                clearKeepalive();
            }
        }, KEEPALIVE_MS);
    }

    const onPageHide = (event: PageTransitionEvent) => {
        if (!event.persisted) return;
        log.info('broadcast: page entering bfcache, releasing port');
        clearKeepalive();
        clearReconnect();
        port = null;
    };
    const onPageShow = (event: PageTransitionEvent) => {
        if (!event.persisted) return;
        log.info('broadcast: page restored from bfcache, reconnecting');
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
