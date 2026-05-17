import type {
    Attachment,
    BroadcastEvent,
    BroadcastRequest,
    ChatMessage,
    ExtensionResponse,
    HydratedChatMessage,
    HydratedStoredMessage,
    StorageRequest,
    StorageResponse,
    StreamHandlers,
    StreamUsage,
    ToolResult,
    TurnRequest,
    UserSettings,
} from '@courier/shared';
import { SETTINGS_KEYS } from '@courier/shared';
import { DEBUG_API_LOGGING } from '../debug';
import {
    CACHE_KEY as OPENROUTER_CACHE_KEY,
    getOpenRouterModels,
} from '../openrouter-models';
import { streamAnthropic } from '../providers/anthropic';
import { streamGoogle } from '../providers/google';
import { streamOpenAI } from '../providers/openai';
import { streamOpenRouter } from '../providers/openrouter';
import {
    dbClearChats,
    dbDeleteChat,
    dbDeleteMessage,
    dbDeleteMessagesAfter,
    dbGetFileBlob,
    dbGetStorageUsage,
    dbLoadChat,
    dbLoadChatMetas,
    dbLoadChats,
    dbLoadChatsByIds,
    dbPutMessage,
    dbSaveMeta,
} from '../storage/db';

async function blobToBase64(blob: Blob): Promise<string> {
    const buf = new Uint8Array(await blob.arrayBuffer());
    // String.fromCharCode in chunks to avoid stack overflow on large buffers.
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < buf.length; i += CHUNK) {
        binary += String.fromCharCode(
            ...buf.subarray(i, Math.min(i + CHUNK, buf.length))
        );
    }
    return btoa(binary);
}

// Hydrates inbound turn messages into a provider-ready list — every
// attachment becomes a full `Attachment` (with `data`) by either keeping the
// inline upload bytes or pulling the blob from the files store. Throws if a
// ref can't be resolved.
//
// Persistence of the user message itself is the web's responsibility
// (separate put_message call); we no longer track freshBlobs here.
async function hydrateTurn(
    messages: ChatMessage[]
): Promise<HydratedChatMessage[]> {
    const dataCache = new Map<string, string>();
    for (const msg of messages) {
        for (const att of msg.attachments ?? []) {
            if ('data' in att && att.data) {
                dataCache.set(att.hash, att.data);
            }
        }
    }

    const hydrated: HydratedChatMessage[] = [];
    for (const msg of messages) {
        if (!msg.attachments?.length) {
            hydrated.push({
                role: msg.role,
                content: msg.content,
                ...(msg.toolResults?.length
                    ? { toolResults: msg.toolResults }
                    : {}),
            });
            continue;
        }
        const filled: Attachment[] = [];
        for (const att of msg.attachments) {
            if ('data' in att && att.data) {
                filled.push(att as Attachment);
                continue;
            }
            let data = dataCache.get(att.hash);
            if (!data) {
                const blob = await dbGetFileBlob(att.hash);
                if (!blob) {
                    throw new Error(
                        `Missing attachment for hash ${att.hash} (${att.name})`
                    );
                }
                data = await blobToBase64(blob);
                dataCache.set(att.hash, data);
            }
            filled.push({
                hash: att.hash,
                name: att.name,
                mediaType: att.mediaType,
                sizeBytes: att.sizeBytes,
                encodedSizeBytes: data.length,
                data,
            });
        }
        hydrated.push({
            role: msg.role,
            content: msg.content,
            attachments: filled,
            ...(msg.toolResults?.length
                ? { toolResults: msg.toolResults }
                : {}),
        });
    }
    return hydrated;
}

type StreamFn = (
    apiKey: string,
    model: string,
    messages: HydratedChatMessage[],
    params: Record<string, unknown>,
    handlers: StreamHandlers,
    signal?: AbortSignal
) => Promise<void>;

const PROVIDERS: Record<string, StreamFn> = {
    anthropic: streamAnthropic,
    openai: streamOpenAI,
    google: streamGoogle,
    openrouter: streamOpenRouter,
};

const LOG = '[courier:ext]';
const API_KEY_PREFIX = 'apiKey_';
const SYNC_API_KEYS_KEY: keyof UserSettings = 'syncApiKeys';
let keyStorageInit: Promise<void> | null = null;

// Per-chat lock. While a chatId is in this map, another tab attempting to
// stream the same chat is rejected so writes can't race.
const inflightTurns = new Map<string, AbortController>();

// Long-lived broadcast ports — one per connected tab. The extension fans out
// turn lifecycle events to every port so tabs can mirror cross-tab streams.
const broadcastPorts = new Set<chrome.runtime.Port>();

function broadcast(event: BroadcastEvent) {
    for (const port of broadcastPorts) {
        try {
            port.postMessage(event);
        } catch {
            // Port closed between iteration and post (e.g. tab entered bfcache,
            // tab closed). Drop it now instead of waiting for onDisconnect so
            // the next broadcast doesn't hit the same dead port.
            broadcastPorts.delete(port);
        }
    }
}

function apiKeyName(provider: string): string {
    return `${API_KEY_PREFIX}${provider}`;
}

async function getApiKeyEntries(
    area: chrome.storage.StorageArea
): Promise<Record<string, string>> {
    const all = await area.get(null);
    return Object.fromEntries(
        Object.entries(all).filter(
            (entry): entry is [string, string] =>
                entry[0].startsWith(API_KEY_PREFIX) &&
                typeof entry[1] === 'string' &&
                entry[1].length > 0
        )
    );
}

async function getSyncApiKeys(): Promise<boolean> {
    const result = await chrome.storage.sync.get(SYNC_API_KEYS_KEY);
    if (typeof result[SYNC_API_KEYS_KEY] === 'boolean') {
        return result[SYNC_API_KEYS_KEY];
    }
    await chrome.storage.sync.set({ [SYNC_API_KEYS_KEY]: false });
    return false;
}

async function reconcileApiKeys(syncApiKeys: boolean): Promise<void> {
    const [localKeys, syncedKeys] = await Promise.all([
        getApiKeyEntries(chrome.storage.local),
        getApiKeyEntries(chrome.storage.sync),
    ]);
    const mergedKeys = { ...localKeys, ...syncedKeys };
    const syncedNames = Object.keys(syncedKeys);
    const mergedNames = Object.keys(mergedKeys);

    // Synced keys hydrate local storage and win conflicts, but API calls never
    // read from sync directly.
    if (syncedNames.length > 0) {
        await chrome.storage.local.set(mergedKeys);
    }

    if (syncApiKeys) {
        if (mergedNames.length > 0) await chrome.storage.sync.set(mergedKeys);
    } else if (syncedNames.length > 0) {
        await chrome.storage.sync.remove(syncedNames);
    }
}

async function applyApiKeySyncPreference(syncApiKeys: boolean): Promise<void> {
    await chrome.storage.sync.set({ [SYNC_API_KEYS_KEY]: syncApiKeys });
    if (syncApiKeys) {
        const localKeys = await getApiKeyEntries(chrome.storage.local);
        if (Object.keys(localKeys).length > 0) {
            await chrome.storage.sync.set(localKeys);
        }
        return;
    }

    const syncedKeys = await getApiKeyEntries(chrome.storage.sync);
    const syncedNames = Object.keys(syncedKeys);
    if (syncedNames.length > 0) await chrome.storage.sync.remove(syncedNames);
}

function initializeKeyStorage(): Promise<void> {
    keyStorageInit ??= getSyncApiKeys().then(reconcileApiKeys);
    return keyStorageInit;
}

async function readApiKey(provider: string): Promise<string | undefined> {
    await initializeKeyStorage();
    const result = await chrome.storage.local.get(apiKeyName(provider));
    return result[apiKeyName(provider)] as string | undefined;
}

// Serializes chrome.storage writes that touch the api-key keyspace (save_key,
// clear_key, save_settings — the latter can flip the sync-preference, which
// mutates the same keys). Per-message IDB writes don't need this — IDB
// serializes transactions on its own — but chrome.storage has no such
// guarantee and `applyApiKeySyncPreference` is read-modify-write on
// chrome.storage.sync.
let keyOpsChain: Promise<void> = Promise.resolve();
function enqueueKeyOp<T>(work: () => Promise<T>): Promise<T> {
    const run = keyOpsChain.then(work, work);
    keyOpsChain = run.then(
        () => {},
        () => {}
    );
    return run;
}

async function handleStorage(
    message: StorageRequest
): Promise<StorageResponse> {
    console.log(LOG, '← storage request', message.type);
    switch (message.type) {
        case 'save_key': {
            return enqueueKeyOp(async () => {
                console.log(
                    LOG,
                    'storage: saving API key for',
                    message.provider
                );
                await initializeKeyStorage();
                const key = apiKeyName(message.provider);
                await chrome.storage.local.set({ [key]: message.apiKey });
                await applyApiKeySyncPreference(message.syncApiKeys);
                console.log(LOG, '→ storage response: saved');
                return { type: 'saved' };
            });
        }
        case 'clear_key': {
            return enqueueKeyOp(async () => {
                console.log(
                    LOG,
                    'storage: clearing API key for',
                    message.provider
                );
                const key = apiKeyName(message.provider);
                await Promise.all([
                    chrome.storage.local.remove(key),
                    chrome.storage.sync.remove(key),
                ]);
                console.log(LOG, '→ storage response: saved');
                return { type: 'saved' };
            });
        }
        case 'has_keys': {
            await initializeKeyStorage();
            const storageKeys = message.providers.map(apiKeyName);
            const result = await chrome.storage.local.get(storageKeys);
            const saved: Record<string, boolean> = {};
            for (const p of message.providers) {
                const val = result[apiKeyName(p)];
                saved[p] = typeof val === 'string' && val.length > 0;
            }
            console.log(LOG, '→ storage response: has_keys', saved);
            return { type: 'has_keys', saved };
        }
        case 'save_settings': {
            return enqueueKeyOp(async () => {
                await initializeKeyStorage();
                const currentSyncApiKeys = await getSyncApiKeys();
                const filtered = Object.fromEntries(
                    SETTINGS_KEYS.filter((k) => k in message.settings).map(
                        (k) => [k, message.settings[k]]
                    )
                );
                const nextSyncApiKeys = filtered[SYNC_API_KEYS_KEY];
                if (
                    typeof nextSyncApiKeys === 'boolean' &&
                    nextSyncApiKeys !== currentSyncApiKeys
                ) {
                    await applyApiKeySyncPreference(nextSyncApiKeys);
                }
                console.log(LOG, 'storage: saving settings', filtered);
                await chrome.storage.sync.set(filtered);
                console.log(LOG, '→ storage response: saved');
                return { type: 'saved' };
            });
        }
        case 'load_settings': {
            await initializeKeyStorage();
            const result = await chrome.storage.sync.get(SETTINGS_KEYS);
            console.log(LOG, '→ storage response: settings', result);
            return {
                type: 'settings',
                settings: result as Partial<UserSettings>,
            };
        }
        case 'save_meta': {
            await dbSaveMeta(message.meta);
            console.log(LOG, '→ storage response: saved');
            return { type: 'saved' };
        }
        case 'put_message': {
            await dbPutMessage(message.message);
            console.log(LOG, '→ storage response: saved');
            return { type: 'saved' };
        }
        case 'delete_message': {
            await dbDeleteMessage(message.chatId, message.messageId);
            console.log(LOG, '→ storage response: saved');
            return { type: 'saved' };
        }
        case 'delete_messages_after': {
            await dbDeleteMessagesAfter(message.chatId, message.lastKeptId);
            console.log(LOG, '→ storage response: saved');
            return { type: 'saved' };
        }
        case 'delete_chat': {
            await dbDeleteChat(message.chatId);
            console.log(LOG, '→ storage response: saved');
            return { type: 'saved' };
        }
        case 'load_chat_metas': {
            const metas = await dbLoadChatMetas();
            console.log(
                LOG,
                '→ storage response: chat_metas',
                `${metas.length} metas`
            );
            return { type: 'chat_metas', metas };
        }
        case 'load_chats': {
            const chats = await dbLoadChats();
            console.log(
                LOG,
                '→ storage response: chats',
                `${chats.length} chats`
            );
            return { type: 'chats', chats };
        }
        case 'load_chats_by_ids': {
            const chats = await dbLoadChatsByIds(message.ids);
            console.log(
                LOG,
                '→ storage response: chats',
                `${chats.length} chats`
            );
            return { type: 'chats', chats };
        }
        case 'load_chat': {
            const chat = await dbLoadChat(message.chatId);
            console.log(
                LOG,
                '→ storage response: chat',
                message.chatId,
                chat ? 'found' : 'not found'
            );
            return { type: 'chat', chat };
        }
        case 'load_openrouter_models': {
            const apiKey = await readApiKey('openrouter');
            const models = await getOpenRouterModels(apiKey);
            console.log(
                LOG,
                '→ storage response: openrouter_models',
                models ? `${models.length} models` : 'unavailable',
                apiKey ? 'with key' : 'cache only'
            );
            return { type: 'openrouter_models', models };
        }
        case 'get_storage_usage': {
            // API keys can sit in both local and sync (when syncApiKeys is on);
            // we deliberately count both — the bytes really are stored twice.
            const [
                idbUsage,
                localTotalBytes,
                openRouterCacheBytes,
                syncSettingsBytes,
            ] = await Promise.all([
                dbGetStorageUsage(),
                chrome.storage.local.getBytesInUse(null),
                chrome.storage.local.getBytesInUse(OPENROUTER_CACHE_KEY),
                chrome.storage.sync.getBytesInUse(null),
            ]);
            const localSettingsBytes = localTotalBytes - openRouterCacheBytes;
            console.log(LOG, '→ storage response: storage_usage', {
                localSettingsBytes,
                openRouterCacheBytes,
                syncSettingsBytes,
                ...idbUsage,
            });
            return {
                type: 'storage_usage',
                localSettingsBytes,
                openRouterCacheBytes,
                syncSettingsBytes,
                ...idbUsage,
            };
        }
        case 'clear_chats': {
            await dbClearChats();
            console.log(LOG, '→ storage response: saved');
            return { type: 'saved' };
        }
        case 'clear_all': {
            await Promise.all([
                dbClearChats(),
                chrome.storage.local.clear(),
                chrome.storage.sync.clear(),
            ]);
            console.log(LOG, '→ storage response: saved');
            return { type: 'saved' };
        }
    }
}

export default defineBackground(() => {
    console.log(LOG, 'background ready');
    // Key storage init runs once at SW boot. If it fails (corrupt sync data,
    // quota error) we keep going — readApiKey/applyApiKeySyncPreference will
    // retry through the same promise on demand and surface the error to the
    // caller (which the web turns into a visible toast).
    initializeKeyStorage().catch((err) =>
        console.error(LOG, 'key storage init failed', err)
    );

    // Internal messages from the popup. The popup shows a generic
    // "Something went wrong" — we forward the actual reason so it can do better.
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message.type === 'admin_clear_chats') {
            dbClearChats()
                .then(() => sendResponse({ ok: true }))
                .catch((err) => {
                    console.error(LOG, 'admin_clear_chats failed', err);
                    sendResponse({
                        ok: false,
                        message:
                            err instanceof Error ? err.message : String(err),
                    });
                });
            return true;
        }
        if (message.type === 'admin_clear_all') {
            Promise.all([
                dbClearChats(),
                chrome.storage.local.clear(),
                chrome.storage.sync.clear(),
            ])
                .then(() => sendResponse({ ok: true }))
                .catch((err) => {
                    console.error(LOG, 'admin_clear_all failed', err);
                    sendResponse({
                        ok: false,
                        message:
                            err instanceof Error ? err.message : String(err),
                    });
                });
            return true;
        }
    });

    // One-off storage operations (save/check API keys, settings, chat history).
    // Any throw inside handleStorage gets converted to a structured error
    // response so the web side learns about it rather than hanging on a
    // missing reply.
    chrome.runtime.onMessageExternal.addListener(
        (message: StorageRequest, _sender, sendResponse) => {
            handleStorage(message)
                .then(sendResponse)
                .catch((err) => {
                    console.error(
                        LOG,
                        'storage handler threw',
                        message.type,
                        err
                    );
                    sendResponse({
                        type: 'error',
                        message:
                            err instanceof Error ? err.message : String(err),
                    });
                });
            return true; // keep channel open for async response
        }
    );

    // Streaming chat over a port. Lifecycle: web sends 'start' to begin a
    // turn, may send 'stop' mid-stream. Extension owns lock + save end-to-end.
    chrome.runtime.onConnectExternal.addListener((port) => {
        // 'broadcast' ports are long-lived fan-out channels for cross-tab
        // turn mirroring. The only inbound traffic is a periodic keepalive
        // from each tab — its sole job is to reset the SW's 30s idle timer
        // so we stay warm whenever the website is open.
        if (port.name === 'broadcast') {
            console.log(LOG, 'broadcast port connected');
            broadcastPorts.add(port);
            port.onMessage.addListener((msg: BroadcastRequest) => {
                if (msg.type === 'keepalive') return;
            });
            port.onDisconnect.addListener(() => {
                // Read lastError to consume any close reason Chrome attached
                // (e.g. bfcache eviction). Without this, Chrome surfaces it as
                // "Unchecked runtime.lastError".
                const reason = chrome.runtime.lastError?.message;
                console.log(
                    LOG,
                    'broadcast port disconnected',
                    reason ? `(${reason})` : ''
                );
                broadcastPorts.delete(port);
            });
            return;
        }

        console.log(LOG, 'turn port connected');
        const controller = new AbortController();

        // Disposition tracks how the turn ends. 'aborted' means web
        // disconnected without a graceful stop (e.g. retry/delete) — we skip
        // the save in that case.
        type Disposition =
            | 'pending'
            | 'streaming'
            | 'stopped'
            | 'aborted'
            | 'completed'
            | 'errored';
        let disposition: Disposition = 'pending';
        let lockedChatId: string | null = null;
        let assistantContent = '';
        let assistantThinking = '';
        let assistantToolResults: ToolResult[] = [];
        let streamUsage: StreamUsage | undefined;
        let streamErrorMsg: string | null = null;
        let stopTruncated = '';
        // Stable id the web pre-allocated for the assistant message we'll
        // append on completion. Null until turn-start lands.
        let assistantMessageId: string | null = null;
        let portOpen = true;

        const send = (response: ExtensionResponse) => {
            if (portOpen) port.postMessage(response);
        };

        port.onDisconnect.addListener(() => {
            portOpen = false;
            console.log(LOG, 'port disconnected, disposition:', disposition);
            if (disposition === 'pending' || disposition === 'streaming') {
                disposition = 'aborted';
                // Release the lock eagerly so a follow-up request (e.g. retry)
                // can re-take it without racing the finally block.
                if (lockedChatId) inflightTurns.delete(lockedChatId);
            }
            controller.abort();
        });

        port.onMessage.addListener(async (msg: TurnRequest) => {
            if (msg.type === 'keepalive') return;

            if (msg.type === 'stop') {
                if (disposition !== 'streaming') return;
                console.log(
                    LOG,
                    'stop received, truncated len:',
                    msg.truncatedContent.length
                );
                disposition = 'stopped';
                stopTruncated = msg.truncatedContent;
                controller.abort();
                return;
            }

            if (disposition !== 'pending') return;

            // Take the lock first so a duplicate tab is rejected immediately.
            if (inflightTurns.has(msg.chatId)) {
                console.log(LOG, 'lock taken, rejecting', msg.chatId);
                send({
                    type: 'error',
                    message: 'Conversation active in another tab.',
                });
                if (portOpen) port.disconnect();
                return;
            }
            inflightTurns.set(msg.chatId, controller);
            lockedChatId = msg.chatId;
            assistantMessageId = msg.assistantMessageId;
            disposition = 'streaming';

            // Announce the turn to every other tab so they can mirror state.
            // The originating tab filters this out by sourceTabId.
            broadcast({
                type: 'turn-start',
                chatId: msg.chatId,
                sourceTabId: msg.sourceTabId,
                meta: msg.meta,
                history: msg.history,
                assistantMessageId: msg.assistantMessageId,
            });

            try {
                const apiKey = await readApiKey(msg.provider);

                if (!apiKey) {
                    console.error(LOG, 'no API key for provider', msg.provider);
                    streamErrorMsg = `No API key saved for ${msg.provider}. Add one in Settings.`;
                    disposition = 'errored';
                    return;
                }

                const stream = PROVIDERS[msg.provider];
                if (!stream) {
                    console.error(LOG, 'unsupported provider', msg.provider);
                    streamErrorMsg = `Unsupported provider: ${msg.provider}`;
                    disposition = 'errored';
                    return;
                }

                let hydratedMessages: HydratedChatMessage[];
                try {
                    hydratedMessages = await hydrateTurn(msg.messages);
                } catch (e) {
                    console.error(LOG, 'hydrate failed', e);
                    streamErrorMsg = e instanceof Error ? e.message : String(e);
                    disposition = 'errored';
                    return;
                }

                console.log(LOG, 'streaming', msg.chatId, {
                    provider: msg.provider,
                    model: msg.model,
                    messages: hydratedMessages.length,
                });

                if (DEBUG_API_LOGGING) {
                    console.log(LOG, '[debug] site → ext request', {
                        provider: msg.provider,
                        model: msg.model,
                        params: msg.params,
                        messages: hydratedMessages,
                    });
                }

                const handlers: StreamHandlers = {
                    onChunk: (text) => {
                        assistantContent += text;
                        if (disposition === 'streaming') {
                            send({ type: 'chunk', content: text });
                            broadcast({
                                type: 'turn-chunk',
                                chatId: msg.chatId,
                                kind: 'content',
                                delta: text,
                            });
                        }
                    },
                    onThinking: (text) => {
                        assistantThinking += text;
                        if (disposition === 'streaming') {
                            send({ type: 'thinking_chunk', content: text });
                            broadcast({
                                type: 'turn-chunk',
                                chatId: msg.chatId,
                                kind: 'thinking',
                                delta: text,
                            });
                        }
                    },
                    onToolResults: (toolResults) => {
                        assistantToolResults = toolResults;
                        if (disposition === 'streaming') {
                            send({ type: 'tool_results', toolResults });
                            broadcast({
                                type: 'turn-tool-results',
                                chatId: msg.chatId,
                                toolResults,
                            });
                        }
                    },
                    onDone: (usage) => {
                        streamUsage = usage;
                    },
                    onError: (m) => {
                        streamErrorMsg = m;
                    },
                };

                await stream(
                    apiKey,
                    msg.model,
                    hydratedMessages,
                    msg.params ?? {},
                    handlers,
                    controller.signal
                );

                if (disposition === 'streaming') {
                    disposition = streamErrorMsg ? 'errored' : 'completed';
                }
            } catch (e: unknown) {
                console.error(LOG, 'stream threw', e);
                if (disposition === 'streaming') {
                    streamErrorMsg = e instanceof Error ? e.message : String(e);
                    disposition = 'errored';
                }
            } finally {
                // Re-widen: TS narrows `disposition` based on assignments in
                // try/catch, but the port listeners can mutate it to 'aborted'
                // or 'stopped' mid-await — narrowing misses those paths.
                let disp = disposition as Disposition;
                // Append the assistant message. Skipped on 'aborted' (web
                // bailed without a graceful stop) and when no visible
                // content landed. Drop-on-empty matches prior behavior on
                // error/empty-stop. dbPutMessage runs inside its own IDB tx
                // that re-checks chat existence — if the chat was deleted
                // mid-stream the row is silently skipped, no orphan.
                if (disp !== 'aborted' && lockedChatId && assistantMessageId) {
                    const isStop = disp === 'stopped';
                    const finalContent = isStop
                        ? stopTruncated
                        : assistantContent;

                    if (finalContent) {
                        const assistantMsg: HydratedStoredMessage = {
                            chatId: lockedChatId,
                            id: assistantMessageId,
                            createdAt: Date.now(),
                            role: 'assistant',
                            content: finalContent,
                            ...(assistantThinking
                                ? { thinking: assistantThinking }
                                : {}),
                            ...(assistantToolResults.length
                                ? { toolResults: assistantToolResults }
                                : {}),
                            ...(streamUsage
                                ? {
                                      tokens: {
                                          input: streamUsage.inputTokens,
                                          output: streamUsage.outputTokens,
                                      },
                                  }
                                : {}),
                        };
                        try {
                            await dbPutMessage(assistantMsg);
                        } catch (err) {
                            // Save failure is loud — flip disposition so the
                            // post-save reporting below sends an error to the
                            // source tab and broadcasts a turn-error to
                            // mirrors. The on-screen text is preserved; only
                            // persistence failed.
                            console.error(LOG, 'save failed', err);
                            const m =
                                err instanceof Error
                                    ? err.message
                                    : String(err);
                            streamErrorMsg = `Couldn't save assistant message: ${m}`;
                            disp = 'errored';
                        }
                    }
                }

                if (disp === 'errored' && streamErrorMsg) {
                    send({ type: 'error', message: streamErrorMsg });
                } else if (disp !== 'aborted') {
                    send({ type: 'done', usage: streamUsage });
                }

                // Fan out the terminal lifecycle event. 'aborted' means the
                // source tab bailed without saving — other tabs should roll
                // back to IDB's pre-turn state.
                if (lockedChatId) {
                    if (disp === 'errored' && streamErrorMsg) {
                        broadcast({
                            type: 'turn-error',
                            chatId: lockedChatId,
                            message: streamErrorMsg,
                        });
                    } else if (disp === 'aborted') {
                        broadcast({
                            type: 'turn-aborted',
                            chatId: lockedChatId,
                        });
                    } else {
                        broadcast({
                            type: 'turn-done',
                            chatId: lockedChatId,
                        });
                    }
                }

                if (lockedChatId) inflightTurns.delete(lockedChatId);
                if (portOpen) port.disconnect();
            }
        });
    });
});
