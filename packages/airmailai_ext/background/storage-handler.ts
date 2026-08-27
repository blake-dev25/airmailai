import type {
    FileAvailability,
    ProviderFileInfo,
    StorageRequest,
    StorageResponse,
    UserSettings,
} from '@airmailai/shared';
import { SETTINGS_KEYS } from '@airmailai/shared';
import { log } from '../debug';
import {
    CACHE_KEY as OPENROUTER_CACHE_KEY,
    MANUAL_REFRESH_KEY as OPENROUTER_MANUAL_REFRESH_KEY,
    getOpenRouterManualRefreshAt,
    getOpenRouterModels,
    refreshOpenRouterModels,
} from '../openrouter-models';
import { listAnthropicFiles } from '../providers/anthropic-files';
import { listOpenAIFiles } from '../providers/openai-files';
import { listGoogleFiles } from '../providers/google-files';
import { testProviderKey } from '../providers/key-test';
import {
    dbClearChats,
    dbClearDraftAttachments,
    dbDeleteChat,
    dbDeleteMessage,
    dbDeleteStoredFile,
    dbGetFileFacts,
    dbListLocalFiles,
    dbLookupProviderFileHashes,
    dbRemoveDraftAttachment,
    dbGetStorageUsage,
    dbLoadChat,
    dbLoadChatMetas,
    dbLoadChatsByIds,
    dbPrepareRetry,
    dbPrepareTurn,
    dbPutMessage,
    dbSaveMeta,
    dbWipeAll,
} from '../storage/db';
import { broadcast } from './ports';
import {
    apiKeyName,
    assertKnownProvider,
    deleteProviderFile,
    deleteProviderFiles,
    readApiKey,
    readProviderFileStorageEnabled,
    replicaFresh,
} from './provider-file-sync';

async function handleStorage(
    message: StorageRequest
): Promise<StorageResponse> {
    log.info('<- storage request', message.type);
    switch (message.type) {
        case 'save_key': {
            assertKnownProvider(message.provider);
            log.info('storage: saving API key for', message.provider);
            const key = apiKeyName(message.provider);
            await chrome.storage.local.set({ [key]: message.apiKey });
            log.info('-> storage response: saved');
            return { type: 'saved' };
        }
        case 'clear_key': {
            assertKnownProvider(message.provider);
            log.info('storage: clearing API key for', message.provider);
            const key = apiKeyName(message.provider);
            await chrome.storage.local.remove(key);
            log.info('-> storage response: saved');
            return { type: 'saved' };
        }
        case 'has_keys': {
            for (const p of message.providers) assertKnownProvider(p);
            const storageKeys = message.providers.map(apiKeyName);
            const result = await chrome.storage.local.get(storageKeys);
            const saved: Record<string, boolean> = {};
            for (const p of message.providers) {
                const val = result[apiKeyName(p)];
                saved[p] = typeof val === 'string' && val.length > 0;
            }
            log.info('-> storage response: has_keys', saved);
            return { type: 'has_keys', saved };
        }
        case 'test_key': {
            assertKnownProvider(message.provider);
            const apiKey = await readApiKey(message.provider);
            if (!apiKey) {
                return {
                    type: 'key_test',
                    ok: false,
                    message: `No API key saved for ${message.provider}.`,
                };
            }
            const result = await testProviderKey(message.provider, apiKey);
            log.info(
                '-> storage response: key_test',
                message.provider,
                result.ok
            );
            return {
                type: 'key_test',
                ok: result.ok,
                ...(result.message ? { message: result.message } : {}),
            };
        }
        case 'save_settings': {
            const filtered = Object.fromEntries(
                SETTINGS_KEYS.filter((k) => k in message.settings).map((k) => [
                    k,
                    message.settings[k],
                ])
            );
            log.info('storage: saving settings', filtered);
            await chrome.storage.sync.set(filtered);
            log.info('-> storage response: saved');
            return { type: 'saved' };
        }
        case 'load_settings': {
            const result = await chrome.storage.sync.get(SETTINGS_KEYS);
            log.info('-> storage response: settings', result);
            return {
                type: 'settings',
                settings: result as Partial<UserSettings>,
            };
        }
        case 'save_meta': {
            await dbSaveMeta(message.meta);
            broadcast(
                { type: 'meta-changed', meta: message.meta },
                message.sourceTabId
            );
            log.info('-> storage response: saved');
            return { type: 'saved' };
        }
        case 'prepare_turn': {
            const refs = await dbPrepareTurn(message.meta, message.message);
            await deleteProviderFiles(refs);
            broadcast(
                { type: 'meta-changed', meta: message.meta },
                message.sourceTabId
            );
            log.info('-> storage response: turn prepared');
            return { type: 'saved' };
        }
        case 'prepare_retry': {
            const refs = await dbPrepareRetry(message.meta, message.lastKeptId);
            await deleteProviderFiles(refs);
            broadcast(
                { type: 'meta-changed', meta: message.meta },
                message.sourceTabId
            );
            log.info('-> storage response: retry prepared');
            return { type: 'saved' };
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
            log.info('-> storage response: saved');
            return { type: 'saved' };
        }
        case 'delete_message': {
            const refs = await dbDeleteMessage(
                message.chatId,
                message.messageId
            );
            await deleteProviderFiles(refs);
            log.info('-> storage response: saved');
            return { type: 'saved' };
        }
        case 'delete_chat': {
            const refs = await dbDeleteChat(message.chatId);
            await deleteProviderFiles(refs);
            broadcast(
                { type: 'chat-deleted', chatId: message.chatId },
                message.sourceTabId
            );
            log.info('-> storage response: saved');
            return { type: 'saved' };
        }
        case 'load_chat_metas': {
            const metas = await dbLoadChatMetas();
            log.info(
                '-> storage response: chat_metas',
                `${metas.length} metas`
            );
            return { type: 'chat_metas', metas };
        }
        case 'load_chats_by_ids': {
            const chats = await dbLoadChatsByIds(message.ids);
            log.info('-> storage response: chats', `${chats.length} chats`);
            return { type: 'chats', chats };
        }
        case 'load_chat': {
            const chat = await dbLoadChat(message.chatId);
            log.info(
                '-> storage response: chat',
                message.chatId,
                chat ? 'found' : 'not found'
            );
            return { type: 'chat', chat };
        }
        case 'load_openrouter_models': {
            const apiKey = await readApiKey('openrouter');
            const models = await getOpenRouterModels(apiKey);
            log.info(
                '-> storage response: openrouter_models',
                models ? `${models.length} models` : 'unavailable',
                apiKey ? 'with key' : 'cache only'
            );
            return { type: 'openrouter_models', models };
        }
        case 'get_openrouter_refresh_status': {
            const lastAttemptAt = await getOpenRouterManualRefreshAt();
            log.info(
                '-> storage response: openrouter_refresh_status',
                lastAttemptAt
            );
            return { type: 'openrouter_refresh_status', lastAttemptAt };
        }
        case 'refresh_openrouter_models': {
            const apiKey = await readApiKey('openrouter');
            const models = await refreshOpenRouterModels(apiKey);
            log.info(
                '-> storage response: openrouter_models',
                `${models.length} models`,
                'manual refresh'
            );
            return { type: 'openrouter_models', models };
        }
        case 'file_status': {
            assertKnownProvider(message.provider);
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
            log.info('-> storage response: file_status', message.hashes.length);
            return { type: 'file_status', statuses };
        }
        case 'list_local_files': {
            const files = await dbListLocalFiles();
            log.info('-> storage response: local_files', files.length);
            return { type: 'local_files', files };
        }
        case 'list_provider_files': {
            assertKnownProvider(message.provider);
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
            log.info(
                '-> storage response: provider_files',
                message.provider,
                files.length
            );
            return { type: 'provider_files', files };
        }
        case 'delete_stored_file': {
            if (message.target.kind === 'provider') {
                assertKnownProvider(message.target.providerId);
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
                log.info(
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
            log.info(
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
                chrome.storage.local.getBytesInUse([
                    OPENROUTER_CACHE_KEY,
                    OPENROUTER_MANUAL_REFRESH_KEY,
                ]),
                chrome.storage.sync.getBytesInUse(null),
            ]);
            const localSettingsBytes = localTotalBytes - openRouterCacheBytes;
            log.info('-> storage response: storage_usage', {
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
            log.info('-> storage response: saved');
            return { type: 'saved' };
        }
        case 'clear_all': {
            await dbWipeAll();
            await Promise.all([
                chrome.storage.local.clear(),
                chrome.storage.sync.clear(),
            ]);
            broadcast({ type: 'chats-cleared' }, message.sourceTabId);
            log.info('-> storage response: saved');
            return { type: 'saved' };
        }
    }
}

export function dispatchStorage(
    message: StorageRequest,
    sendResponse: (response: StorageResponse) => void
): true {
    handleStorage(message)
        .then(sendResponse)
        .catch((err) => {
            log.error('storage handler threw', message.type, err);
            sendResponse({
                type: 'error',
                message: err instanceof Error ? err.message : String(err),
            });
        });
    return true;
}
