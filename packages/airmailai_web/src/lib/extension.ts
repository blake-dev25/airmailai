import type {
    BroadcastEvent,
    BroadcastRequest,
    ChatMeta,
    ChatPageCursor,
    AirmailAIChunk,
    DraftAttachment,
    DraftAttachmentMeta,
    ExtensionProbeRequest,
    ExtensionStreamEvent,
    FileAvailability,
    FileDeleteTarget,
    FileTransferRequest,
    FileTransferResponse,
    ImportChatEntry,
    LocalFileInfo,
    OpenRouterModel,
    ProviderFileInfo,
    StorageRequest,
    StorageResponse,
    StorageUsage,
    StoredChat,
    StoredMessage,
    StreamErrorSource,
    TurnStartRequest,
    UserSettings,
} from '@airmailai/shared';
import { EXTENSION_ID, FILE_TRANSFER_CHUNK_BYTES } from '@airmailai/shared';

export interface StreamHandlers {
    onChunk: (chunk: AirmailAIChunk) => void;
    onDone: (revision: number) => void;
    onError: (
        message: string,
        source: StreamErrorSource,
        revision?: number
    ) => void;
}

export interface StreamHandle {
    abort: () => void;
    stop: (truncateTo: number) => void;
}

export const tabId = crypto.randomUUID();

import { log } from './log';
const KEEPALIVE_MS = 20_000;

let extensionId: string | null = null;
let extensionVersion: string | null = null;
let extensionVersionName: string | null = null;

export function getExtensionVersion(): {
    version: string | null;
    versionName: string | null;
} {
    return { version: extensionVersion, versionName: extensionVersionName };
}

const DETECT_TIMEOUT_MS = 5000;

export function waitForExtension(): Promise<boolean> {
    if (extensionId) return Promise.resolve(true);
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage)
        return Promise.resolve(false);
    return new Promise((resolve) => {
        let settled = false;
        const finish = (detected: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolve(detected);
        };
        const timeout = setTimeout(() => {
            log.error('extension probe timed out');
            finish(false);
        }, DETECT_TIMEOUT_MS);
        try {
            chrome.runtime.sendMessage(
                EXTENSION_ID,
                { type: 'get_extension_info' } satisfies ExtensionProbeRequest,
                (response: unknown) => {
                    const error = chrome.runtime.lastError;
                    if (settled) return;
                    if (error) {
                        log.info('extension unavailable', error.message);
                        finish(false);
                        return;
                    }
                    if (
                        !response ||
                        typeof response !== 'object' ||
                        !('type' in response) ||
                        response.type !== 'extension_info' ||
                        !('version' in response) ||
                        typeof response.version !== 'string' ||
                        !response.version ||
                        !('versionName' in response) ||
                        (response.versionName !== null &&
                            typeof response.versionName !== 'string')
                    ) {
                        log.error('invalid extension probe response', response);
                        finish(false);
                        return;
                    }
                    extensionId = EXTENSION_ID;
                    extensionVersion = response.version;
                    extensionVersionName = response.versionName;
                    log.info(
                        'extension detected',
                        extensionId,
                        extensionVersion
                    );
                    finish(true);
                }
            );
        } catch (error) {
            log.error('extension probe failed', error);
            finish(false);
        }
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

const FILE_TRANSFER_WINDOW = 3;

interface FileTransferChannel {
    request: (message: FileTransferRequest) => Promise<FileTransferResponse>;
    disconnect: () => void;
}

function openFileTransferChannel(): FileTransferChannel {
    if (!extensionId) throw new Error('Extension not detected.');
    const port = chrome.runtime.connect(extensionId, { name: 'file-transfer' });
    const pending: Array<{
        resolve: (response: FileTransferResponse) => void;
        reject: (error: Error) => void;
    }> = [];
    let failure: Error | null = null;

    const failAll = (error: Error) => {
        failure = error;
        for (const waiter of pending.splice(0)) waiter.reject(error);
    };

    port.onMessage.addListener((response: FileTransferResponse) => {
        if (response.type === 'error') {
            failAll(new Error(response.message));
            return;
        }
        pending.shift()?.resolve(response);
    });
    port.onDisconnect.addListener(() => {
        failAll(
            new Error(
                chrome.runtime.lastError?.message ??
                    'Extension disconnected during file transfer.'
            )
        );
    });

    return {
        request(message: FileTransferRequest) {
            return new Promise((resolve, reject) => {
                if (failure) {
                    reject(failure);
                    return;
                }
                pending.push({ resolve, reject });
                try {
                    port.postMessage(message);
                } catch (error) {
                    pending.pop();
                    reject(
                        error instanceof Error
                            ? error
                            : new Error(String(error))
                    );
                }
            });
        },
        disconnect: () => port.disconnect(),
    };
}

async function settleBeforeThrow(
    inFlight: Promise<void>[],
    error: unknown
): Promise<never> {
    await Promise.allSettled(inFlight);
    throw error;
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

export async function testApiKey(
    provider: string
): Promise<{ ok: boolean; message?: string }> {
    const response = await sendStorageMessage({ type: 'test_key', provider });
    if (response.type === 'key_test') {
        return {
            ok: response.ok,
            ...(response.message ? { message: response.message } : {}),
        };
    }
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

export async function prepareTurn(
    meta: ChatMeta,
    message: StoredMessage
): Promise<number> {
    const response = await sendStorageMessage({
        type: 'prepare_turn',
        meta,
        message,
        sourceTabId: tabId,
    });
    if (response.type === 'turn_prepared') return response.revision;
    throw new Error(`Unexpected response: ${response.type}`);
}

export async function prepareRetry(
    meta: ChatMeta,
    lastKeptId: string
): Promise<number> {
    const response = await sendStorageMessage({
        type: 'prepare_retry',
        meta,
        lastKeptId,
        sourceTabId: tabId,
    });
    if (response.type === 'turn_prepared') return response.revision;
    throw new Error(`Unexpected response: ${response.type}`);
}

export async function putMessage(message: StoredMessage): Promise<void> {
    await sendStorageMessage({
        type: 'put_message',
        message,
        sourceTabId: tabId,
    });
}

export async function importChats(chats: ImportChatEntry[]): Promise<void> {
    await sendStorageMessage({ type: 'import_chats', chats });
}

export async function stageDraftAttachment(
    chatId: string,
    attachment: DraftAttachmentMeta,
    file: File,
    replicateTo?: string,
    onProgress?: (progress: number) => void
): Promise<DraftAttachment> {
    const chunkCount = Math.ceil(file.size / FILE_TRANSFER_CHUNK_BYTES);
    const channel = openFileTransferChannel();
    try {
        const ready = await channel.request({
            type: 'upload_start',
            chatId,
            attachment,
            chunkCount,
            sourceTabId: tabId,
            ...(replicateTo ? { replicateTo } : {}),
        });
        if (ready.type !== 'upload_ready') {
            throw new Error(`Unexpected response: ${ready.type}`);
        }
        const inFlight: Promise<void>[] = [];
        let savedChunks = 0;
        try {
            for (let index = 0; index < chunkCount; index++) {
                const start = index * FILE_TRANSFER_CHUNK_BYTES;
                const bytes = new Uint8Array(
                    await file
                        .slice(start, start + FILE_TRANSFER_CHUNK_BYTES)
                        .arrayBuffer()
                );
                const ack = channel
                    .request({
                        type: 'upload_chunk',
                        index,
                        base64: bytes.toBase64(),
                    })
                    .then((response) => {
                        if (
                            response.type !== 'upload_chunk_saved' ||
                            response.index !== index
                        ) {
                            throw new Error(
                                `Unexpected response: ${response.type}`
                            );
                        }
                        savedChunks++;
                        onProgress?.(savedChunks / chunkCount);
                    });
                inFlight.push(ack);
                if (inFlight.length >= FILE_TRANSFER_WINDOW) {
                    await inFlight.shift();
                }
            }
            await Promise.all(inFlight);
        } catch (error) {
            await settleBeforeThrow(inFlight, error);
        }
        const saved = await channel.request({ type: 'upload_complete' });
        if (saved.type !== 'upload_saved') {
            throw new Error(`Unexpected response: ${saved.type}`);
        }
        onProgress?.(1);
        return { ...attachment, hash: saved.hash };
    } finally {
        channel.disconnect();
    }
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
    await sendStorageMessage({
        type: 'delete_message',
        chatId,
        messageId,
        sourceTabId: tabId,
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
    const chats: StoredChat[] = [];
    for (const id of ids) {
        const chat = await loadChat(id);
        if (chat) chats.push(chat);
    }
    return chats;
}

export async function loadChat(
    chatId: string,
    messageId?: string
): Promise<StoredChat | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
        let cursor: ChatPageCursor | undefined;
        let revision: number | undefined;
        let pending = '';
        const messages: StoredMessage[] = [];
        let changed = false;
        do {
            const response = await sendStorageMessage({
                type: 'load_chat_page',
                chatId,
                cursor,
                messageId,
            });
            if (response.type !== 'chat_page')
                throw new Error(`Unexpected response: ${response.type}`);
            if (!response.exists) return null;
            if (revision !== undefined && revision !== response.revision) {
                changed = true;
                break;
            }
            revision = response.revision;
            pending += response.data;
            let newline = pending.indexOf('\n');
            while (newline !== -1) {
                messages.push(
                    JSON.parse(pending.slice(0, newline)) as StoredMessage
                );
                pending = pending.slice(newline + 1);
                newline = pending.indexOf('\n');
            }
            cursor = response.cursor ?? undefined;
        } while (cursor);
        if (!changed) {
            if (pending) throw new Error('Incomplete chat history received.');
            return { id: chatId, messages, revision: revision ?? 0 };
        }
    }
    throw new Error(
        'The conversation changed while loading. Please try again.'
    );
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

export async function getOpenRouterRefreshStatus(): Promise<number | null> {
    const response = await sendStorageMessage({
        type: 'get_openrouter_refresh_status',
    });
    if (response.type === 'openrouter_refresh_status') {
        return response.lastAttemptAt;
    }
    throw new Error(`Unexpected response: ${response.type}`);
}

export async function refreshOpenRouterModels(): Promise<OpenRouterModel[]> {
    const response = await sendStorageMessage({
        type: 'refresh_openrouter_models',
    });
    if (response.type === 'openrouter_models' && response.models) {
        return response.models;
    }
    throw new Error(`Unexpected response: ${response.type}`);
}

const FILE_BLOB_CACHE_MAX_BYTES = 128 * 1024 * 1024;
const fileBlobCache = new Map<string, Promise<Blob | null>>();
const fileBlobSizes = new Map<string, number>();
let fileBlobCacheBytes = 0;

export function forgetFileBlob(hash: string): void {
    fileBlobCache.delete(hash);
    const size = fileBlobSizes.get(hash);
    if (size === undefined) return;
    fileBlobSizes.delete(hash);
    fileBlobCacheBytes -= size;
}

function rememberFileBlob(hash: string, blob: Blob): void {
    if (blob.size > FILE_BLOB_CACHE_MAX_BYTES) {
        forgetFileBlob(hash);
        return;
    }
    fileBlobSizes.set(hash, blob.size);
    fileBlobCacheBytes += blob.size;
    for (const key of [...fileBlobSizes.keys()]) {
        if (fileBlobCacheBytes <= FILE_BLOB_CACHE_MAX_BYTES) break;
        if (key !== hash) forgetFileBlob(key);
    }
}

export function clearFileBlobCache(): void {
    fileBlobCache.clear();
    fileBlobSizes.clear();
    fileBlobCacheBytes = 0;
}

export function getFileBlob(hash: string): Promise<Blob | null> {
    const cached = fileBlobCache.get(hash);
    if (cached) return cached;
    const pending = downloadFileBlob(hash).then(
        (blob) => {
            if (fileBlobCache.get(hash) !== pending) return blob;
            if (blob) rememberFileBlob(hash, blob);
            else fileBlobCache.delete(hash);
            return blob;
        },
        (err) => {
            if (fileBlobCache.get(hash) === pending) fileBlobCache.delete(hash);
            throw err;
        }
    );
    fileBlobCache.set(hash, pending);
    return pending;
}

async function downloadFileBlob(hash: string): Promise<Blob | null> {
    const channel = openFileTransferChannel();
    try {
        const ready = await channel.request({
            type: 'download_start',
            hash,
        });
        if (ready.type === 'download_missing') return null;
        if (ready.type !== 'download_ready') {
            throw new Error(`Unexpected response: ${ready.type}`);
        }
        const chunks: Blob[] = [];
        const inFlight: Promise<void>[] = [];
        try {
            for (let index = 0; index < ready.chunkCount; index++) {
                const receipt = channel
                    .request({ type: 'download_chunk', index })
                    .then((response) => {
                        if (response.type !== 'download_chunk') {
                            throw new Error(
                                `Unexpected response: ${response.type}`
                            );
                        }
                        if (response.index !== index) {
                            throw new Error(
                                'File chunks arrived out of order.'
                            );
                        }
                        chunks[index] = new Blob([
                            Uint8Array.fromBase64(response.base64),
                        ]);
                    });
                inFlight.push(receipt);
                if (inFlight.length >= FILE_TRANSFER_WINDOW) {
                    await inFlight.shift();
                }
            }
            await Promise.all(inFlight);
        } catch (error) {
            await settleBeforeThrow(inFlight, error);
        }
        const blob = new Blob(chunks, { type: ready.mediaType });
        if (blob.size !== ready.sizeBytes) {
            throw new Error('Downloaded file size does not match storage.');
        }
        return blob;
    } finally {
        channel.disconnect();
    }
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
            'AirmailAI extension not detected. Install it and refresh to start chatting.',
            'extension'
        );
        return { abort: () => {}, stop: () => {} };
    }

    log.info('-> chat request', {
        chatId: request.chatId,
        provider: request.provider,
        model: request.model,
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
                handlers.onDone(event.revision);
                port.disconnect();
                break;
            }
            case 'error':
                done = true;
                log.error('<- stream error', event.source, event.message);
                handlers.onError(event.message, event.source, event.revision);
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
}): BroadcastSubscription {
    let port: chrome.runtime.Port | null = null;
    let unsubscribed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

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
