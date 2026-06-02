import type {
    BroadcastEvent,
    BroadcastRequest,
    CourierAIChunk,
    CourierAIMessage,
    ExtensionStreamEvent,
    HydratedStoredMessage,
    StorageRequest,
    StorageResponse,
    TurnRequest,
    UserSettings,
} from '@courierai/shared';
import {
    SETTINGS_KEYS,
    applyCourierAIChunk,
    createMessageAssembler,
} from '@courierai/shared';
import { DEBUG_API_LOGGING } from '../debug';
import {
    CACHE_KEY as OPENROUTER_CACHE_KEY,
    getOpenRouterModels,
} from '../openrouter-models';
import { streamProvider } from '../providers/stream';
import {
    dbClearChats,
    dbDeleteChat,
    dbDeleteMessage,
    dbDeleteMessagesAfter,
    dbGetStorageUsage,
    dbLoadChat,
    dbLoadChatMetas,
    dbLoadChats,
    dbLoadChatsByIds,
    dbPutMessage,
    dbSaveMeta,
} from '../storage/db';

const LOG = '[courierai:ext]';
const API_KEY_PREFIX = 'apiKey_';

// Per-chat lock. While a chatId is in this map, another tab attempting to
// stream the same chat is rejected so writes can't race.
const inflightTurns = new Map<string, AbortController>();

// Long-lived broadcast ports - one per connected tab. Mapped to the web's
// sourceTabId (set via the 'register' message immediately after connect) so
// `broadcast()` can skip the source tab when fanning turn-* events. In the
// single-tab case there's exactly one port and it matches the turn's source,
// turning every broadcast into a no-op (zero structured clones on the
// streaming hot path).
const broadcastPorts = new Map<chrome.runtime.Port, string | undefined>();

function broadcast(event: BroadcastEvent, skipTabId?: string) {
    for (const [port, tabId] of broadcastPorts) {
        if (skipTabId && tabId === skipTabId) continue;
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

async function readApiKey(provider: string): Promise<string | undefined> {
    const result = await chrome.storage.local.get(apiKeyName(provider));
    return result[apiKeyName(provider)] as string | undefined;
}

async function handleStorage(
    message: StorageRequest
): Promise<StorageResponse> {
    console.log(LOG, '<- storage request', message.type);
    switch (message.type) {
        case 'save_key': {
            console.log(LOG, 'storage: saving API key for', message.provider);
            const key = apiKeyName(message.provider);
            await chrome.storage.local.set({ [key]: message.apiKey });
            console.log(LOG, '-> storage response: saved');
            return { type: 'saved' };
        }
        case 'clear_key': {
            console.log(LOG, 'storage: clearing API key for', message.provider);
            const key = apiKeyName(message.provider);
            await chrome.storage.local.remove(key);
            console.log(LOG, '-> storage response: saved');
            return { type: 'saved' };
        }
        case 'has_keys': {
            const storageKeys = message.providers.map(apiKeyName);
            const result = await chrome.storage.local.get(storageKeys);
            const saved: Record<string, boolean> = {};
            for (const p of message.providers) {
                const val = result[apiKeyName(p)];
                saved[p] = typeof val === 'string' && val.length > 0;
            }
            console.log(LOG, '-> storage response: has_keys', saved);
            return { type: 'has_keys', saved };
        }
        case 'save_settings': {
            const filtered = Object.fromEntries(
                SETTINGS_KEYS.filter((k) => k in message.settings).map((k) => [
                    k,
                    message.settings[k],
                ])
            );
            console.log(LOG, 'storage: saving settings', filtered);
            await chrome.storage.sync.set(filtered);
            console.log(LOG, '-> storage response: saved');
            return { type: 'saved' };
        }
        case 'load_settings': {
            const result = await chrome.storage.sync.get(SETTINGS_KEYS);
            console.log(LOG, '-> storage response: settings', result);
            return {
                type: 'settings',
                settings: result as Partial<UserSettings>,
            };
        }
        case 'save_meta': {
            await dbSaveMeta(message.meta);
            console.log(LOG, '-> storage response: saved');
            return { type: 'saved' };
        }
        case 'put_message': {
            await dbPutMessage(message.message);
            console.log(LOG, '-> storage response: saved');
            return { type: 'saved' };
        }
        case 'delete_message': {
            await dbDeleteMessage(message.chatId, message.messageId);
            console.log(LOG, '-> storage response: saved');
            return { type: 'saved' };
        }
        case 'delete_messages_after': {
            await dbDeleteMessagesAfter(message.chatId, message.lastKeptId);
            console.log(LOG, '-> storage response: saved');
            return { type: 'saved' };
        }
        case 'delete_chat': {
            await dbDeleteChat(message.chatId);
            console.log(LOG, '-> storage response: saved');
            return { type: 'saved' };
        }
        case 'load_chat_metas': {
            const metas = await dbLoadChatMetas();
            console.log(
                LOG,
                '-> storage response: chat_metas',
                `${metas.length} metas`
            );
            return { type: 'chat_metas', metas };
        }
        case 'load_chats': {
            const chats = await dbLoadChats();
            console.log(
                LOG,
                '-> storage response: chats',
                `${chats.length} chats`
            );
            return { type: 'chats', chats };
        }
        case 'load_chats_by_ids': {
            const chats = await dbLoadChatsByIds(message.ids);
            console.log(
                LOG,
                '-> storage response: chats',
                `${chats.length} chats`
            );
            return { type: 'chats', chats };
        }
        case 'load_chat': {
            const chat = await dbLoadChat(message.chatId);
            console.log(
                LOG,
                '-> storage response: chat',
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
                '-> storage response: openrouter_models',
                models ? `${models.length} models` : 'unavailable',
                apiKey ? 'with key' : 'cache only'
            );
            return { type: 'openrouter_models', models };
        }
        case 'get_storage_usage': {
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
            console.log(LOG, '-> storage response: storage_usage', {
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
            console.log(LOG, '-> storage response: saved');
            return { type: 'saved' };
        }
        case 'clear_all': {
            await Promise.all([
                dbClearChats(),
                chrome.storage.local.clear(),
                chrome.storage.sync.clear(),
            ]);
            console.log(LOG, '-> storage response: saved');
            return { type: 'saved' };
        }
    }
}

// Trim text parts (in render order) to `maxChars` total, dropping parts past
// the cut. Mirror of `truncateMessageTextParts` on the web side; kept local
// to the ext so the two packages don't share runtime code.
function truncateAssistantParts(msg: CourierAIMessage, maxChars: number): void {
    let textConsumed = 0;
    let i = 0;
    while (i < msg.parts.length) {
        const part = msg.parts[i];
        if (part.type === 'text') {
            const remaining = maxChars - textConsumed;
            if (remaining <= 0) {
                msg.parts.splice(i);
                return;
            }
            if (part.text.length > remaining) {
                part.text = part.text.slice(0, remaining);
                part.state = 'done';
                msg.parts.splice(i + 1);
                return;
            }
            textConsumed += part.text.length;
        }
        i++;
    }
}

export default defineBackground(() => {
    console.log(LOG, 'background ready');

    // Internal messages from the popup. The popup shows a generic
    // "Something went wrong" - we forward the actual reason so it can do better.
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
        // from each tab - its sole job is to reset the SW's 30s idle timer
        // so we stay warm whenever the website is open.
        if (port.name === 'broadcast') {
            console.log(LOG, 'broadcast port connected');
            broadcastPorts.set(port, undefined);
            port.onMessage.addListener((msg: BroadcastRequest) => {
                if (msg.type === 'register') {
                    broadcastPorts.set(port, msg.sourceTabId);
                    return;
                }
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
        // disconnected without a graceful stop (e.g. retry/delete) - we skip
        // the save in that case. 'stopped' means web sent an explicit stop;
        // we save whatever was assembled by the abort point.
        type Disposition =
            | 'pending'
            | 'streaming'
            | 'stopped'
            | 'aborted'
            | 'completed'
            | 'errored';
        let disposition: Disposition = 'pending';
        let lockedChatId: string | null = null;
        let lockedSourceTabId: string | null = null;
        let assistantMessageId: string | null = null;
        let inStreamErrorText: string | null = null;
        let portOpen = true;
        // Set by the 'stop' message: visible char count from the source tab.
        // Applied to the assembled message before save so the persisted row
        // matches what the user saw on screen at click time.
        let truncateTo: number | null = null;

        const send = (event: ExtensionStreamEvent) => {
            if (portOpen) port.postMessage(event);
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
            if (msg.type === 'stop') {
                if (disposition !== 'streaming') return;
                console.log(
                    LOG,
                    'stop received',
                    'truncateTo:',
                    msg.truncateTo
                );
                disposition = 'stopped';
                truncateTo = msg.truncateTo;
                // Mirror tabs need to snap their assistant placeholder before
                // turn-done triggers their IDB refresh, or they'd flash the
                // full received chunks then shrink. Source tab's broadcast
                // port is tagged with its sourceTabId so it's skipped here.
                if (lockedChatId) {
                    broadcast(
                        {
                            type: 'turn-truncate',
                            chatId: lockedChatId,
                            charLen: msg.truncateTo,
                        },
                        lockedSourceTabId ?? undefined
                    );
                }
                controller.abort();
                return;
            }

            if (disposition !== 'pending') return;

            // Take the lock first so a duplicate tab is rejected immediately.
            if (inflightTurns.has(msg.chatId)) {
                console.log(LOG, 'lock taken, rejecting', msg.chatId);
                send({
                    type: 'error',
                    source: 'extension',
                    message: 'Conversation active in another tab.',
                });
                if (portOpen) port.disconnect();
                return;
            }
            inflightTurns.set(msg.chatId, controller);
            lockedChatId = msg.chatId;
            lockedSourceTabId = msg.sourceTabId;
            assistantMessageId = msg.assistantMessageId;
            disposition = 'streaming';

            // Announce the turn to every other tab so they can mirror state.
            // Source tab is skipped server-side (its broadcast port is tagged
            // with the same sourceTabId).
            broadcast(
                {
                    type: 'turn-start',
                    chatId: msg.chatId,
                    sourceTabId: msg.sourceTabId,
                    meta: msg.meta,
                    history: msg.history,
                    assistantMessageId: msg.assistantMessageId,
                },
                msg.sourceTabId
            );

            // Fold the provider chunk stream into the assistant message as it
            // arrives, so the terminal save has the complete CourierAIMessage.
            const assembler = createMessageAssembler({
                id: msg.assistantMessageId,
                role: 'assistant',
                parts: [],
                metadata: { createdAt: Date.now() },
            });

            try {
                const apiKey = await readApiKey(msg.provider);
                if (!apiKey) {
                    console.error(LOG, 'no API key for provider', msg.provider);
                    send({
                        type: 'error',
                        source: 'extension',
                        message: `No API key saved for ${msg.provider}. Add one in Settings.`,
                    });
                    disposition = 'errored';
                    return;
                }

                console.log(LOG, 'streaming', msg.chatId, {
                    provider: msg.provider,
                    model: msg.model,
                    messages: msg.messages.length,
                });

                if (DEBUG_API_LOGGING) {
                    console.log(LOG, '[debug] site -> ext request', {
                        provider: msg.provider,
                        model: msg.model,
                        params: msg.params,
                        system: msg.system,
                        messages: msg.messages,
                    });
                }

                let chunkStream: AsyncIterable<CourierAIChunk>;
                try {
                    chunkStream = streamProvider(msg.provider, {
                        apiKey,
                        model: msg.model,
                        messages: msg.messages,
                        system: msg.system,
                        params: msg.params ?? {},
                        signal: controller.signal,
                    });
                } catch (e) {
                    // Sync errors (unknown provider, malformed config).
                    console.error(LOG, 'streamProvider threw', e);
                    send({
                        type: 'error',
                        source: 'extension',
                        message: e instanceof Error ? e.message : String(e),
                    });
                    disposition = 'errored';
                    return;
                }

                for await (const chunk of chunkStream) {
                    applyCourierAIChunk(assembler, chunk);
                    if (disposition === 'streaming') {
                        send({ type: 'chunk', chunk });
                        broadcast(
                            { type: 'turn-chunk', chatId: msg.chatId, chunk },
                            msg.sourceTabId
                        );
                    }
                }

                if (disposition === 'streaming') {
                    disposition = 'completed';
                }
            } catch (e: unknown) {
                // Provider generators throw on API/stream error (after the
                // for-await begins). Aborts return silently, so a throw here is
                // a real error unless a port listener already flipped the
                // disposition to 'stopped'/'aborted'.
                console.error(LOG, 'stream threw', e);
                if (disposition === 'streaming') {
                    inStreamErrorText =
                        e instanceof Error ? e.message : String(e);
                    disposition = 'errored';
                }
            } finally {
                // Re-widen: TS narrows `disposition` based on assignments in
                // try/catch, but the port listeners can mutate it to
                // 'aborted' or 'stopped' mid-await - narrowing misses those
                // paths.
                let disp = disposition as Disposition;

                // Persist the assembled assistant message. Skipped on 'aborted'
                // (web bailed without a graceful stop) and when nothing
                // assembled. On graceful stop, truncateTo trims text parts to
                // the source tab's visible char count so the persisted row
                // matches what the user saw.
                const assembled = assembler.message;
                if (
                    disp !== 'aborted' &&
                    lockedChatId &&
                    assistantMessageId &&
                    assembled.parts.length > 0
                ) {
                    if (truncateTo !== null) {
                        truncateAssistantParts(assembled, truncateTo);
                    }
                    const finalMessage: CourierAIMessage = {
                        ...assembled,
                        id: assistantMessageId,
                        role: 'assistant',
                        metadata: {
                            createdAt: Date.now(),
                            ...(assembled.metadata.tokens
                                ? { tokens: assembled.metadata.tokens }
                                : {}),
                            ...(assembled.metadata.stopReason
                                ? { stopReason: assembled.metadata.stopReason }
                                : {}),
                        },
                    };
                    const stored: HydratedStoredMessage = {
                        chatId: lockedChatId,
                        message: finalMessage,
                    };
                    try {
                        await dbPutMessage(stored);
                    } catch (err) {
                        console.error(LOG, 'save failed', err);
                        const m =
                            err instanceof Error ? err.message : String(err);
                        inStreamErrorText = `Couldn't save assistant message: ${m}`;
                        disp = 'errored';
                    }
                }

                if (disp === 'errored' && inStreamErrorText) {
                    send({
                        type: 'error',
                        source: 'api',
                        message: inStreamErrorText,
                    });
                } else if (disp !== 'aborted') {
                    send({ type: 'done' });
                }

                // Fan out the terminal lifecycle event. 'aborted' means the
                // source tab bailed without saving - other tabs should roll
                // back to IDB's pre-turn state. Source tab is skipped - it
                // already knows the disposition via the turn port.
                if (lockedChatId) {
                    if (disp === 'errored' && inStreamErrorText) {
                        broadcast(
                            {
                                type: 'turn-error',
                                chatId: lockedChatId,
                                message: inStreamErrorText,
                            },
                            msg.sourceTabId
                        );
                    } else if (disp === 'aborted') {
                        broadcast(
                            { type: 'turn-aborted', chatId: lockedChatId },
                            msg.sourceTabId
                        );
                    } else {
                        broadcast(
                            { type: 'turn-done', chatId: lockedChatId },
                            msg.sourceTabId
                        );
                    }
                }

                if (lockedChatId) inflightTurns.delete(lockedChatId);
                if (portOpen) port.disconnect();
            }
        });
    });
});
