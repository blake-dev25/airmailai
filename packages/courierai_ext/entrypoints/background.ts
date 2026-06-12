import type {
    BroadcastEvent,
    BroadcastRequest,
    CourierAIChunk,
    CourierAIMessage,
    ExtensionStreamEvent,
    FileAvailability,
    HydratedStoredMessage,
    ProviderFileEntry,
    ProviderFileInfo,
    ProviderFileRef,
    StorageRequest,
    StorageResponse,
    StreamErrorSource,
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
import {
    deleteAnthropicFile,
    listAnthropicFiles,
    uploadAnthropicFile,
} from '../providers/anthropic-files';
import {
    deleteOpenAIFile,
    listOpenAIFiles,
    uploadOpenAIFile,
} from '../providers/openai-files';
import {
    downloadOpenAIContainerFile,
    listOpenAIContainerFiles,
} from '../providers/openai-container-files';
import {
    deleteGoogleFile,
    listGoogleFiles,
    uploadGoogleFile,
} from '../providers/google-files';
import { streamProvider } from '../providers/stream';
import {
    dbClearChats,
    dbClearDraftAttachments,
    dbDeleteChat,
    dbDeleteMessage,
    dbDeleteMessagesAfter,
    dbDeleteStoredFile,
    dbForgetProviderFile,
    dbGetFileBlob,
    dbGetFileBlobBase64,
    dbGetFileFacts,
    dbListLocalFiles,
    dbGetMeta,
    dbLookupProviderFile,
    dbLookupProviderFileHashes,
    dbRecordProviderFile,
    dbRemoveDraftAttachment,
    dbStageDraftAttachment,
    dbGetStorageUsage,
    dbLoadChat,
    dbLoadChatMetas,
    dbLoadChats,
    dbLoadChatsByIds,
    dbPutMessage,
    dbSaveMeta,
    dbSetContainer,
    dbWipeAll,
} from '../storage/db';
import { base64ToBytes, bytesToBase64, hashBytes } from '../storage/encoding';

const LOG = '[courierai:ext]';
const API_KEY_PREFIX = 'apiKey_';

const inflightTurns = new Set<string>();

const broadcastPorts = new Map<chrome.runtime.Port, string | undefined>();

function broadcast(event: BroadcastEvent, skipTabId?: string) {
    for (const [port, tabId] of broadcastPorts) {
        if (skipTabId && tabId === skipTabId) continue;
        try {
            port.postMessage(event);
        } catch {
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

async function readProviderFileStorageEnabled(): Promise<boolean> {
    const result = await chrome.storage.sync.get('enableProviderFileStorage');
    return result.enableProviderFileStorage === true;
}

async function deleteProviderFile(
    providerId: string,
    apiKey: string,
    fileId: string
): Promise<string[]> {
    if (providerId === 'anthropic') {
        await deleteAnthropicFile(apiKey, fileId);
    } else if (providerId === 'openai') {
        await deleteOpenAIFile(apiKey, fileId);
    } else if (providerId === 'google') {
        await deleteGoogleFile(apiKey, fileId);
    }
    return dbForgetProviderFile(providerId, fileId);
}

async function deleteProviderFiles(refs: ProviderFileRef[]): Promise<void> {
    if (!refs.length) return;
    const byProvider = new Map<string, string[]>();
    const seen = new Set<string>();
    for (const ref of refs) {
        const key = `${ref.providerId}:${ref.fileId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const list = byProvider.get(ref.providerId) ?? [];
        list.push(ref.fileId);
        byProvider.set(ref.providerId, list);
    }
    for (const [providerId, fileIds] of byProvider) {
        const apiKey = await readApiKey(providerId);
        if (!apiKey) {
            console.warn(
                LOG,
                'orphaned provider files left (no api key)',
                providerId,
                fileIds.length
            );
            continue;
        }
        for (const fileId of fileIds) {
            try {
                await deleteProviderFile(providerId, apiKey, fileId);
            } catch (err) {
                console.error(
                    LOG,
                    'failed to delete orphaned provider file',
                    providerId,
                    fileId,
                    err
                );
            }
        }
    }
}

const FILE_PROVIDERS = new Set(['anthropic', 'openai', 'google']);
const REPLICA_EXPIRY_MARGIN_MS = 60_000;

function replicaFresh(entry: ProviderFileEntry): boolean {
    return (
        entry.expiresAt === undefined ||
        Date.now() < entry.expiresAt - REPLICA_EXPIRY_MARGIN_MS
    );
}

async function uploadWithDedup(
    provider: string,
    apiKey: string,
    bytes: Uint8Array<ArrayBuffer>,
    mediaType: string,
    filename: string
): Promise<ProviderFileEntry> {
    const hash = await hashBytes(bytes.buffer);
    const existing = await dbLookupProviderFile(hash, provider);
    if (existing && replicaFresh(existing)) {
        console.log(
            LOG,
            'dedup: reusing provider file',
            provider,
            existing.fileId
        );
        return existing;
    }
    let entry: ProviderFileEntry;
    if (provider === 'anthropic') {
        entry = {
            fileId: await uploadAnthropicFile(
                apiKey,
                bytes,
                mediaType,
                filename
            ),
        };
    } else if (provider === 'openai') {
        entry = {
            fileId: await uploadOpenAIFile(apiKey, bytes, mediaType, filename),
        };
    } else if (provider === 'google') {
        entry = await uploadGoogleFile(apiKey, bytes, mediaType, filename);
    } else {
        throw new Error(
            `Provider file storage is not supported for ${provider}.`
        );
    }
    await dbRecordProviderFile(hash, provider, entry, filename, mediaType);
    return entry;
}

async function ensureReplicas(
    messages: CourierAIMessage[],
    provider: string,
    apiKey: string
): Promise<Record<string, ProviderFileEntry> | undefined> {
    const infos = new Map<string, { filename: string; mediaType: string }>();
    for (const msg of messages) {
        for (const part of msg.parts) {
            if (part.type === 'file') {
                infos.set(part.hash, {
                    filename: part.filename,
                    mediaType: part.mediaType,
                });
            }
        }
    }
    if (!infos.size) return undefined;
    const map: Record<string, ProviderFileEntry> = {};
    for (const [hash, info] of infos) {
        let entry = await dbLookupProviderFile(hash, provider);
        if (!entry || !replicaFresh(entry)) {
            const blob = await dbGetFileBlob(hash);
            if (!blob) {
                console.warn(LOG, 'replica skipped, no local bytes', hash);
                continue;
            }
            console.log(LOG, 'replicating file to provider', provider, hash);
            entry = await uploadWithDedup(
                provider,
                apiKey,
                new Uint8Array(await blob.arrayBuffer()),
                blob.type || info.mediaType,
                info.filename
            );
        }
        map[hash] = entry;
    }
    return Object.keys(map).length ? map : undefined;
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
        case 'stage_draft_attachment': {
            await dbStageDraftAttachment(
                message.chatId,
                message.attachment,
                message.base64
            );
            let warning: string | undefined;
            if (
                message.replicateTo &&
                FILE_PROVIDERS.has(message.replicateTo)
            ) {
                try {
                    const apiKey = await readApiKey(message.replicateTo);
                    if (!apiKey) {
                        throw new Error(
                            `No API key saved for ${message.replicateTo}.`
                        );
                    }
                    await uploadWithDedup(
                        message.replicateTo,
                        apiKey,
                        base64ToBytes(message.base64),
                        message.attachment.mediaType,
                        message.attachment.name
                    );
                } catch (err) {
                    console.error(LOG, 'draft replica upload failed', err);
                    warning = err instanceof Error ? err.message : String(err);
                }
            }
            return { type: 'saved', ...(warning ? { warning } : {}) };
        }
        case 'remove_draft_attachment': {
            const refs = await dbRemoveDraftAttachment(
                message.chatId,
                message.key
            );
            await deleteProviderFiles(refs);
            return { type: 'saved' };
        }
        case 'clear_draft_attachments': {
            const refs = await dbClearDraftAttachments(message.chatId);
            await deleteProviderFiles(refs);
            return { type: 'saved' };
        }
        case 'put_message': {
            const refs = await dbPutMessage(message.message);
            await deleteProviderFiles(refs);
            console.log(LOG, '-> storage response: saved');
            return { type: 'saved' };
        }
        case 'delete_message': {
            const refs = await dbDeleteMessage(
                message.chatId,
                message.messageId
            );
            await deleteProviderFiles(refs);
            console.log(LOG, '-> storage response: saved');
            return { type: 'saved' };
        }
        case 'delete_messages_after': {
            const refs = await dbDeleteMessagesAfter(
                message.chatId,
                message.lastKeptId
            );
            await deleteProviderFiles(refs);
            console.log(LOG, '-> storage response: saved');
            return { type: 'saved' };
        }
        case 'delete_chat': {
            const refs = await dbDeleteChat(message.chatId);
            await deleteProviderFiles(refs);
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
        case 'get_file_blob': {
            const blob = await dbGetFileBlobBase64(message.hash);
            console.log(LOG, '-> storage response: file_blob', !!blob);
            return { type: 'file_blob', blob };
        }
        case 'file_status': {
            const storageOn = await readProviderFileStorageEnabled();
            const facts = await dbGetFileFacts(
                message.hashes,
                message.provider
            );
            const statuses: Record<string, FileAvailability> = {};
            for (const [hash, f] of Object.entries(facts)) {
                if (f.local) statuses[hash] = 'local';
                else if (!f.providerEntry || !storageOn)
                    statuses[hash] = 'missing';
                else if (replicaFresh(f.providerEntry))
                    statuses[hash] = 'provider';
                else statuses[hash] = 'expired';
            }
            console.log(
                LOG,
                '-> storage response: file_status',
                message.hashes.length
            );
            return { type: 'file_status', statuses };
        }
        case 'list_local_files': {
            const files = await dbListLocalFiles();
            console.log(LOG, '-> storage response: local_files', files.length);
            return { type: 'local_files', files };
        }
        case 'list_provider_files': {
            const apiKey = await readApiKey(message.provider);
            if (!apiKey) {
                return {
                    type: 'error',
                    message: `No API key for ${message.provider}.`,
                };
            }
            let files: ProviderFileInfo[];
            if (message.provider === 'anthropic') {
                files = await listAnthropicFiles(apiKey);
            } else if (message.provider === 'openai') {
                files = await listOpenAIFiles(apiKey);
            } else if (message.provider === 'google') {
                files = await listGoogleFiles(apiKey);
            } else {
                return {
                    type: 'error',
                    message: `File listing for ${message.provider} isn't supported yet.`,
                };
            }
            const hashes = await dbLookupProviderFileHashes(message.provider);
            files = files.map((f) => {
                const hash = hashes.get(f.fileId);
                return hash ? { ...f, hash } : f;
            });
            console.log(
                LOG,
                '-> storage response: provider_files',
                message.provider,
                files.length
            );
            return { type: 'provider_files', files };
        }
        case 'delete_stored_file': {
            if (message.target.kind === 'provider') {
                const apiKey = await readApiKey(message.target.providerId);
                if (!apiKey) {
                    return {
                        type: 'error',
                        message: `No API key for ${message.target.providerId}.`,
                    };
                }
                const chatIds = await deleteProviderFile(
                    message.target.providerId,
                    apiKey,
                    message.target.fileId
                );
                if (chatIds.length) {
                    broadcast(
                        { type: 'files-changed', chatIds },
                        message.sourceTabId
                    );
                }
                console.log(
                    LOG,
                    '-> storage response: provider file deleted',
                    message.target.fileId
                );
                return { type: 'stored_file_deleted', chatIds };
            }
            const chatIds = await dbDeleteStoredFile(message.target.hash);
            if (chatIds.length) {
                broadcast(
                    { type: 'files-changed', chatIds },
                    message.sourceTabId
                );
            }
            console.log(
                LOG,
                '-> storage response: stored_file_deleted',
                chatIds.length
            );
            return { type: 'stored_file_deleted', chatIds };
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
            broadcast({ type: 'chats-cleared' }, message.sourceTabId);
            console.log(LOG, '-> storage response: saved');
            return { type: 'saved' };
        }
        case 'clear_all': {
            await dbWipeAll();
            await Promise.all([
                chrome.storage.local.clear(),
                chrome.storage.sync.clear(),
            ]);
            broadcast({ type: 'chats-cleared' }, message.sourceTabId);
            console.log(LOG, '-> storage response: saved');
            return { type: 'saved' };
        }
    }
}

interface OpenAICaptureResult {
    freshBlobs: HydratedStoredMessage['freshBlobs'];
    containerFileIds: string[];
    warning?: string;
}

async function captureOpenAIOutputs(
    message: CourierAIMessage,
    chatId: string,
    apiKey: string,
    containerId: string,
    storageOn: boolean
): Promise<OpenAICaptureResult> {
    const meta = await dbGetMeta(chatId);
    const captured = new Set(
        meta?.containerId === containerId ? (meta.containerFileIds ?? []) : []
    );
    const files = await listOpenAIContainerFiles(apiKey, containerId);
    const freshBlobs: Record<string, { mediaType: string; base64: string }> =
        {};
    const containerFileIds: string[] = [];
    const warnings: string[] = [];
    for (const f of files) {
        if (f.source !== 'assistant') continue;
        containerFileIds.push(f.fileId);
        if (captured.has(f.fileId)) continue;
        const buf = await downloadOpenAIContainerFile(
            apiKey,
            containerId,
            f.fileId
        );
        const bytes = new Uint8Array(buf);
        const hash = await hashBytes(buf);
        freshBlobs[hash] = {
            mediaType: f.mediaType,
            base64: bytesToBase64(bytes),
        };
        message.parts.push({
            type: 'file',
            filename: f.filename,
            mediaType: f.mediaType,
            sizeBytes: bytes.byteLength,
            hash,
        });
        if (storageOn) {
            try {
                await uploadWithDedup(
                    'openai',
                    apiKey,
                    bytes,
                    f.mediaType,
                    f.filename
                );
            } catch (err) {
                console.error(LOG, 'output replica upload failed', err);
                warnings.push(
                    `${f.filename}: ${err instanceof Error ? err.message : String(err)}`
                );
            }
        }
    }
    return {
        freshBlobs: Object.keys(freshBlobs).length ? freshBlobs : undefined,
        containerFileIds,
        ...(warnings.length ? { warning: warnings.join('; ') } : {}),
    };
}

function replicaUsableWithoutBytes(
    provider: string,
    entry: ProviderFileEntry
): boolean {
    return provider === 'google' ? entry.uri !== undefined : true;
}

async function hydrateBlobs(
    messages: CourierAIMessage[],
    provider: string,
    replicas: Record<string, ProviderFileEntry> | undefined
): Promise<Record<string, { mediaType: string; base64: string }>> {
    const mediaTypes = new Map<string, string>();
    for (const m of messages) {
        for (const part of m.parts) {
            if (part.type === 'file') mediaTypes.set(part.hash, part.mediaType);
        }
    }
    const blobs: Record<string, { mediaType: string; base64: string }> = {};
    for (const [hash, mediaType] of mediaTypes) {
        const replica = replicas?.[hash];
        if (
            replica &&
            replicaUsableWithoutBytes(provider, replica) &&
            !mediaType.startsWith('text/')
        ) {
            continue;
        }
        const b = await dbGetFileBlobBase64(hash);
        if (b) blobs[hash] = b;
    }
    return blobs;
}

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
                dbWipeAll(),
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
            return true;
        }
    );

    chrome.runtime.onConnectExternal.addListener((port) => {
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
        let errorSource: StreamErrorSource = 'api';
        let portOpen = true;
        let truncateTo: number | null = null;

        const send = (event: ExtensionStreamEvent) => {
            if (portOpen) port.postMessage(event);
        };

        port.onDisconnect.addListener(() => {
            portOpen = false;
            console.log(LOG, 'port disconnected, disposition:', disposition);
            if (disposition === 'pending' || disposition === 'streaming') {
                disposition = 'aborted';
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
            inflightTurns.add(msg.chatId);
            lockedChatId = msg.chatId;
            lockedSourceTabId = msg.sourceTabId;
            assistantMessageId = msg.assistantMessageId;
            disposition = 'streaming';

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

            const assembler = createMessageAssembler({
                id: msg.assistantMessageId,
                role: 'assistant',
                parts: [],
                metadata: { createdAt: Date.now() },
            });

            let capturedContainerId: string | undefined;
            let capturedContainerExpiresAt: string | undefined;
            let storageOn = false;
            let apiKey: string | undefined;
            const outputWarnings: string[] = [];
            const streamOutputBlobs: Record<
                string,
                { mediaType: string; base64: string }
            > = {};

            try {
                apiKey = await readApiKey(msg.provider);
                if (!apiKey) {
                    console.error(LOG, 'no API key for provider', msg.provider);
                    inStreamErrorText = `No API key saved for ${msg.provider}. Add one in Settings.`;
                    errorSource = 'extension';
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

                storageOn = await readProviderFileStorageEnabled();
                let providerFiles:
                    | Record<string, ProviderFileEntry>
                    | undefined;
                if (FILE_PROVIDERS.has(msg.provider) && storageOn) {
                    providerFiles = await ensureReplicas(
                        msg.messages,
                        msg.provider,
                        apiKey
                    );
                }
                const blobs = await hydrateBlobs(
                    msg.messages,
                    msg.provider,
                    providerFiles
                );

                let turnParams = msg.params ?? {};
                if (msg.provider === 'anthropic' || msg.provider === 'openai') {
                    const wireTools = (turnParams.tools ?? {}) as Record<
                        string,
                        unknown
                    >;
                    if (wireTools.codeExecution) {
                        const meta = await dbGetMeta(msg.chatId);
                        if (
                            meta?.containerId &&
                            meta.containerExpiresAt &&
                            new Date(meta.containerExpiresAt).getTime() -
                                60_000 >
                                Date.now()
                        ) {
                            turnParams = {
                                ...turnParams,
                                container: meta.containerId,
                            };
                            console.log(
                                LOG,
                                'reusing container',
                                meta.containerId
                            );
                        }
                    }
                }

                let chunkStream: AsyncIterable<CourierAIChunk>;
                try {
                    chunkStream = streamProvider(msg.provider, {
                        apiKey,
                        model: msg.model,
                        messages: msg.messages,
                        system: msg.system,
                        params: turnParams,
                        signal: controller.signal,
                        blobs,
                        providerFiles,
                    });
                } catch (e) {
                    console.error(LOG, 'streamProvider threw', e);
                    inStreamErrorText =
                        e instanceof Error ? e.message : String(e);
                    errorSource = 'extension';
                    disposition = 'errored';
                    return;
                }

                for await (const chunk of chunkStream) {
                    let outbound = chunk;
                    if (chunk.type === 'file' && chunk.base64) {
                        streamOutputBlobs[chunk.hash] = {
                            mediaType: chunk.mediaType,
                            base64: chunk.base64,
                        };
                        if (chunk.replicaFileId) {
                            try {
                                if (storageOn) {
                                    await dbRecordProviderFile(
                                        chunk.hash,
                                        msg.provider,
                                        { fileId: chunk.replicaFileId },
                                        chunk.filename,
                                        chunk.mediaType
                                    );
                                } else {
                                    await deleteProviderFile(
                                        msg.provider,
                                        apiKey,
                                        chunk.replicaFileId
                                    );
                                }
                            } catch (err) {
                                console.error(
                                    LOG,
                                    'output replica policy failed',
                                    err
                                );
                                const m =
                                    err instanceof Error
                                        ? err.message
                                        : String(err);
                                outputWarnings.push(
                                    storageOn
                                        ? `Couldn't record a provider copy of ${chunk.filename} (will retry on your next message): ${m}`
                                        : `Couldn't delete ${chunk.filename} from ${msg.provider} storage (you can delete it from the Files tab): ${m}`
                                );
                            }
                        }
                        const stripped = { ...chunk };
                        delete stripped.base64;
                        delete stripped.replicaFileId;
                        outbound = stripped;
                    }
                    applyCourierAIChunk(assembler, chunk);
                    if (chunk.type === 'finish') {
                        if (chunk.containerId)
                            capturedContainerId = chunk.containerId;
                        if (chunk.containerExpiresAt)
                            capturedContainerExpiresAt =
                                chunk.containerExpiresAt;
                    }
                    if (disposition === 'streaming') {
                        send({ type: 'chunk', chunk: outbound });
                        broadcast(
                            {
                                type: 'turn-chunk',
                                chatId: msg.chatId,
                                chunk: outbound,
                            },
                            msg.sourceTabId
                        );
                    }
                }

                if (disposition === 'streaming') {
                    disposition = 'completed';
                }
            } catch (e: unknown) {
                console.error(LOG, 'stream threw', e);
                if (disposition === 'streaming') {
                    inStreamErrorText =
                        e instanceof Error ? e.message : String(e);
                    disposition = 'errored';
                }
            } finally {
                let disp = disposition as Disposition;
                const assembled = assembler.message;
                if (truncateTo !== null) {
                    truncateAssistantParts(assembled, truncateTo);
                }
                if (
                    disp !== 'aborted' &&
                    lockedChatId &&
                    assistantMessageId &&
                    assembled.parts.length > 0
                ) {
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
                    let freshBlobs: HydratedStoredMessage['freshBlobs'];
                    let containerFileIds: string[] | undefined;
                    if (
                        apiKey &&
                        msg.provider === 'openai' &&
                        capturedContainerId
                    ) {
                        try {
                            const captured = await captureOpenAIOutputs(
                                finalMessage,
                                lockedChatId,
                                apiKey,
                                capturedContainerId,
                                storageOn
                            );
                            freshBlobs = captured.freshBlobs;
                            containerFileIds = captured.containerFileIds;
                            if (captured.warning) {
                                outputWarnings.push(
                                    `Saved generated file(s) on this device, but couldn't copy to OpenAI storage (will retry on your next message): ${captured.warning}`
                                );
                            }
                        } catch (err) {
                            console.error(LOG, 'output capture failed', err);
                            inStreamErrorText = `Couldn't download generated file(s): ${err instanceof Error ? err.message : String(err)}`;
                            disp = 'errored';
                        }
                    }
                    if (Object.keys(streamOutputBlobs).length) {
                        freshBlobs = { ...streamOutputBlobs, ...freshBlobs };
                    }
                    const stored: HydratedStoredMessage = {
                        chatId: lockedChatId,
                        message: finalMessage,
                        ...(freshBlobs ? { freshBlobs } : {}),
                    };
                    try {
                        const refs = await dbPutMessage(stored);
                        await deleteProviderFiles(refs);
                    } catch (err) {
                        console.error(LOG, 'save failed', err);
                        const m =
                            err instanceof Error ? err.message : String(err);
                        inStreamErrorText = `Couldn't save assistant message: ${m}`;
                        disp = 'errored';
                    }
                    if (capturedContainerId) {
                        try {
                            await dbSetContainer(
                                lockedChatId,
                                capturedContainerId,
                                capturedContainerExpiresAt,
                                containerFileIds
                            );
                        } catch (err) {
                            console.error(LOG, 'container persist failed', err);
                        }
                    }
                    if (outputWarnings.length && disp !== 'errored') {
                        inStreamErrorText = outputWarnings.join('\n');
                        disp = 'errored';
                    }
                }

                if (disp === 'errored' && inStreamErrorText) {
                    send({
                        type: 'error',
                        source: errorSource,
                        message: inStreamErrorText,
                    });
                } else if (disp !== 'aborted') {
                    send({ type: 'done' });
                }

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
