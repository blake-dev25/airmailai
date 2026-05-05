import type {
    BroadcastEvent,
    ChatMessage,
    ChatMeta,
    ExtensionResponse,
    StorageRequest,
    StorageResponse,
    StoredChat,
    StreamHandlers,
    StreamUsage,
    TurnRequest,
    UserSettings,
} from '@courier/shared';
import { SETTINGS_KEYS } from '@courier/shared';
import { DEBUG_API_LOGGING } from '../debug';
import { streamAnthropic } from '../providers/anthropic';
import { streamGoogle } from '../providers/google';
import { streamOpenAI } from '../providers/openai';
import {
    dbClearChats,
    dbDeleteChat,
    dbLoadChat,
    dbLoadChatMetas,
    dbLoadChats,
    dbLoadChatsByIds,
    dbSaveChat,
} from '../storage/db';

type StreamFn = (
    apiKey: string,
    model: string,
    messages: ChatMessage[],
    params: Record<string, unknown>,
    handlers: StreamHandlers,
    signal?: AbortSignal
) => Promise<void>;

const PROVIDERS: Record<string, StreamFn> = {
    anthropic: streamAnthropic,
    openai: streamOpenAI,
    google: streamGoogle,
};

const LOG = '[courier:ext]';

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
            // Port may have closed between the iteration and post; cleaned up
            // by its onDisconnect listener.
        }
    }
}

async function handleStorage(
    message: StorageRequest
): Promise<StorageResponse> {
    console.log(LOG, '← storage request', message.type);
    switch (message.type) {
        case 'save_key': {
            console.log(LOG, 'storage: saving API key for', message.provider);
            await chrome.storage.sync.set({
                [`apiKey_${message.provider}`]: message.apiKey,
            });
            console.log(LOG, '→ storage response: saved');
            return { type: 'saved' };
        }
        case 'clear_key': {
            console.log(LOG, 'storage: clearing API key for', message.provider);
            await chrome.storage.sync.remove(`apiKey_${message.provider}`);
            console.log(LOG, '→ storage response: saved');
            return { type: 'saved' };
        }
        case 'has_keys': {
            const storageKeys = message.providers.map((p) => `apiKey_${p}`);
            const result = await chrome.storage.sync.get(storageKeys);
            const saved: Record<string, boolean> = {};
            for (const p of message.providers) {
                const val = result[`apiKey_${p}`];
                saved[p] = typeof val === 'string' && val.length > 0;
            }
            console.log(LOG, '→ storage response: has_keys', saved);
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
            console.log(LOG, '→ storage response: saved');
            return { type: 'saved' };
        }
        case 'load_settings': {
            const result = await chrome.storage.sync.get(SETTINGS_KEYS);
            console.log(LOG, '→ storage response: settings', result);
            return {
                type: 'settings',
                settings: result as Partial<UserSettings>,
            };
        }
        case 'save_chat': {
            await dbSaveChat(message.chat, message.meta);
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
    }
}

export default defineBackground(() => {
    console.log(LOG, 'background ready');

    // Internal messages from the popup
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message.type === 'admin_clear_chats') {
            dbClearChats()
                .then(() => sendResponse({ ok: true }))
                .catch(() => sendResponse({ ok: false }));
            return true;
        }
        if (message.type === 'admin_clear_all') {
            Promise.all([dbClearChats(), chrome.storage.sync.clear()])
                .then(() => sendResponse({ ok: true }))
                .catch(() => sendResponse({ ok: false }));
            return true;
        }
    });

    // One-off storage operations (save/check API keys, settings, chat history)
    chrome.runtime.onMessageExternal.addListener(
        (message: StorageRequest, _sender, sendResponse) => {
            handleStorage(message).then(sendResponse);
            return true; // keep channel open for async response
        }
    );

    // Streaming chat over a port. Lifecycle: web sends 'start' to begin a
    // turn, may send 'stop' mid-stream. Extension owns lock + save end-to-end.
    chrome.runtime.onConnectExternal.addListener((port) => {
        // 'broadcast' ports are long-lived fan-out channels for cross-tab
        // turn mirroring. They never receive turn requests; they just listen.
        if (port.name === 'broadcast') {
            console.log(LOG, 'broadcast port connected');
            broadcastPorts.add(port);
            port.onDisconnect.addListener(() => {
                console.log(LOG, 'broadcast port disconnected');
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
        let streamUsage: StreamUsage | undefined;
        let streamErrorMsg: string | null = null;
        let stopTruncated = '';
        let saveCtx: {
            meta: ChatMeta;
            history: StoredChat['messages'];
        } | null = null;
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
            saveCtx = { meta: msg.meta, history: msg.historyForSave };
            disposition = 'streaming';

            // Announce the turn to every other tab so they can mirror state.
            // The originating tab filters this out by sourceTabId.
            broadcast({
                type: 'turn-start',
                chatId: msg.chatId,
                sourceTabId: msg.sourceTabId,
                meta: msg.meta,
                history: msg.historyForSave,
            });

            try {
                const keyResult = await chrome.storage.sync.get(
                    `apiKey_${msg.provider}`
                );
                const apiKey = keyResult[`apiKey_${msg.provider}`] as
                    | string
                    | undefined;

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

                console.log(LOG, 'streaming', msg.chatId, {
                    provider: msg.provider,
                    model: msg.model,
                    messages: msg.messages.length,
                });

                if (DEBUG_API_LOGGING) {
                    console.log(LOG, '[debug] full request', {
                        provider: msg.provider,
                        model: msg.model,
                        params: msg.params,
                        messages: msg.messages,
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
                    msg.messages,
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
                // Save phase. Skipped on 'aborted' (web bailed without stop).
                if (disposition !== 'aborted' && saveCtx && lockedChatId) {
                    const isStop = disposition === 'stopped';
                    const finalContent = isStop
                        ? stopTruncated
                        : assistantContent;

                    const newMessages: StoredChat['messages'] = [
                        ...saveCtx.history,
                    ];
                    // Drop the assistant turn entirely if no visible content
                    // landed (matches prior web-side behavior on error/empty stop).
                    if (finalContent) {
                        newMessages.push({
                            role: 'assistant',
                            content: finalContent,
                            ...(assistantThinking
                                ? { thinking: assistantThinking }
                                : {}),
                        });
                    }

                    const stored: StoredChat = {
                        id: lockedChatId,
                        messages: newMessages,
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
                        await dbSaveChat(stored, saveCtx.meta);
                    } catch (err) {
                        console.error(LOG, 'save failed', err);
                    }
                }

                if (disposition === 'errored' && streamErrorMsg) {
                    send({ type: 'error', message: streamErrorMsg });
                } else if (disposition !== 'aborted') {
                    send({ type: 'done', usage: streamUsage });
                }

                // Fan out the terminal lifecycle event. 'aborted' means the
                // source tab bailed without saving — other tabs should roll
                // back to IDB's pre-turn state.
                if (lockedChatId) {
                    if (disposition === 'errored' && streamErrorMsg) {
                        broadcast({
                            type: 'turn-error',
                            chatId: lockedChatId,
                            message: streamErrorMsg,
                        });
                    } else if (disposition === 'aborted') {
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
