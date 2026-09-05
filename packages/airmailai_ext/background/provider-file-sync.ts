import type {
    AirmailAIMessage,
    ProviderFileEntry,
    ProviderFileRef,
} from '@airmailai/shared';
import { log } from '../debug';
import {
    deleteAnthropicFile,
    uploadAnthropicFile,
} from '../providers/anthropic-files';
import { deleteOpenAIFile, uploadOpenAIFile } from '../providers/openai-files';
import { deleteGoogleFile, uploadGoogleFile } from '../providers/google-files';
import {
    dbForgetProviderFile,
    dbGetFileBlob,
    dbLookupProviderFile,
    dbRecordProviderFile,
} from '../storage/db';

const API_KEY_PREFIX = 'apiKey_';

export function apiKeyName(provider: string): string {
    return `${API_KEY_PREFIX}${provider}`;
}

export async function readApiKey(
    provider: string
): Promise<string | undefined> {
    const result = await chrome.storage.local.get(apiKeyName(provider));
    return result[apiKeyName(provider)] as string | undefined;
}

export async function readProviderFileStorageEnabled(): Promise<boolean> {
    const result = await chrome.storage.sync.get('enableProviderFileStorage');
    return result.enableProviderFileStorage === true;
}

async function deleteRemoteProviderFile(
    providerId: string,
    apiKey: string,
    fileId: string
): Promise<void> {
    try {
        if (providerId === 'anthropic') {
            await deleteAnthropicFile(apiKey, fileId);
        } else if (providerId === 'openai') {
            await deleteOpenAIFile(apiKey, fileId);
        } else if (providerId === 'google') {
            await deleteGoogleFile(apiKey, fileId);
        }
    } catch (error) {
        const alreadyGone =
            error instanceof Error && 'status' in error && error.status === 404;
        if (!alreadyGone) throw error;
    }
}

export async function deleteProviderFile(
    providerId: string,
    apiKey: string,
    fileId: string
): Promise<string[]> {
    await deleteRemoteProviderFile(providerId, apiKey, fileId);
    return dbForgetProviderFile(providerId, fileId);
}

export async function deleteProviderFiles(
    refs: ProviderFileRef[]
): Promise<string[]> {
    const warnings: string[] = [];
    if (!refs.length) return warnings;
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
            log.warn(
                'orphaned provider files left (no api key)',
                providerId,
                fileIds.length
            );
            warnings.push(
                `Couldn't delete ${fileIds.length} unused ${providerId} file${fileIds.length === 1 ? '' : 's'} (no API key saved). You can remove them from the Files tab after adding a key.`
            );
            continue;
        }
        await Promise.all(
            fileIds.map(async (fileId) => {
                try {
                    await deleteProviderFile(providerId, apiKey, fileId);
                } catch (err) {
                    log.error(
                        'failed to delete orphaned provider file',
                        providerId,
                        fileId,
                        err
                    );
                    warnings.push(
                        `Couldn't delete an unused ${providerId} file (${fileId}): ${err instanceof Error ? err.message : String(err)}. You can remove it from the Files tab.`
                    );
                }
            })
        );
    }
    return warnings;
}

export async function deleteTemporaryProviderFiles(
    refs: ProviderFileRef[],
    apiKey: string
): Promise<string[]> {
    const warnings: string[] = [];
    await Promise.all(
        refs.map(async (ref) => {
            try {
                await deleteRemoteProviderFile(
                    ref.providerId,
                    apiKey,
                    ref.fileId
                );
            } catch (error) {
                log.error(
                    'temporary provider file cleanup failed',
                    ref.providerId,
                    ref.fileId,
                    error
                );
                warnings.push(
                    `Couldn't delete a temporary ${ref.providerId} file (${ref.fileId}). You can remove it from the provider dashboard.`
                );
            }
        })
    );
    return warnings;
}

export const FILE_PROVIDERS = new Set(['anthropic', 'openai', 'google']);
const KNOWN_PROVIDERS = new Set([...FILE_PROVIDERS, 'openrouter']);

const MB = 1024 * 1024;
const PROVIDER_MAX_FILE_BYTES: Record<string, number> = {
    anthropic: 500 * MB,
    google: 2048 * MB,
    openai: 512 * MB,
    openrouter: 8 * MB,
};

export function fileTooLargeForProvider(
    provider: string,
    sizeBytes: number
): boolean {
    const max = PROVIDER_MAX_FILE_BYTES[provider];
    return max !== undefined && sizeBytes > max;
}

export function assertKnownProvider(provider: string): void {
    if (!KNOWN_PROVIDERS.has(provider)) {
        throw new Error(`Unknown provider: ${provider}`);
    }
}
const REPLICA_EXPIRY_MARGIN_MS = 60_000;

export function replicaFresh(entry: ProviderFileEntry): boolean {
    return (
        entry.expiresAt === undefined ||
        Date.now() < entry.expiresAt - REPLICA_EXPIRY_MARGIN_MS
    );
}

const inflightProviderUploads = new Map<string, Promise<ProviderFileEntry>>();

export function uploadWithDedup(
    hash: string,
    provider: string,
    apiKey: string,
    blob: Blob,
    mediaType: string,
    filename: string,
    signal?: AbortSignal
): Promise<ProviderFileEntry> {
    const key = `${provider}:${hash}`;
    const inflight = inflightProviderUploads.get(key);
    if (inflight) {
        log.info('dedup: joining in-flight provider upload', key);
        return inflight;
    }
    const task = (async () => {
        const existing = await dbLookupProviderFile(hash, provider);
        if (existing && replicaFresh(existing)) {
            log.info('dedup: reusing provider file', provider, existing.fileId);
            return existing;
        }
        const entry = await uploadProviderBlob(
            provider,
            apiKey,
            blob,
            mediaType,
            filename,
            signal
        );
        await dbRecordProviderFile(hash, provider, entry, filename, mediaType);
        return entry;
    })();
    inflightProviderUploads.set(key, task);
    task.catch(() => {}).finally(() => inflightProviderUploads.delete(key));
    return task;
}

async function uploadProviderBlob(
    provider: string,
    apiKey: string,
    blob: Blob,
    mediaType: string,
    filename: string,
    signal?: AbortSignal
): Promise<ProviderFileEntry> {
    if (provider === 'anthropic') {
        return {
            fileId: await uploadAnthropicFile(
                apiKey,
                blob,
                mediaType,
                filename,
                signal
            ),
        };
    }
    if (provider === 'openai') {
        return {
            fileId: await uploadOpenAIFile(
                apiKey,
                blob,
                mediaType,
                filename,
                signal
            ),
        };
    }
    if (provider === 'google') {
        return uploadGoogleFile(apiKey, blob, mediaType, filename, signal);
    }
    throw new Error(`Provider file storage is not supported for ${provider}.`);
}

interface PreparedProviderFiles {
    files: Record<string, ProviderFileEntry> | undefined;
    ephemeral: ProviderFileRef[];
    missing: string[];
}

const PROVIDER_UPLOAD_CONCURRENCY = 3;

async function runWithConcurrency<T>(
    items: T[],
    limit: number,
    task: (item: T) => Promise<void>
): Promise<void> {
    const queue = [...items];
    const errors: unknown[] = [];
    const workers = Array.from(
        { length: Math.min(limit, queue.length) },
        async () => {
            while (queue.length && !errors.length) {
                const item = queue.shift();
                if (item === undefined) break;
                try {
                    await task(item);
                } catch (error) {
                    errors.push(error);
                }
            }
        }
    );
    await Promise.all(workers);
    if (errors.length) throw errors[0];
}

export async function prepareProviderFiles(
    messages: AirmailAIMessage[],
    provider: string,
    apiKey: string,
    persistent: boolean,
    signal?: AbortSignal,
    requiredHashes: ReadonlySet<string> = new Set()
): Promise<PreparedProviderFiles> {
    const infos = new Map<
        string,
        { filename: string; mediaType: string; sizeBytes: number }
    >();
    for (const msg of messages) {
        for (const part of msg.parts) {
            if (part.type === 'file') {
                infos.set(part.hash, {
                    filename: part.filename,
                    mediaType: part.mediaType,
                    sizeBytes: part.sizeBytes,
                });
            }
        }
    }
    if (!infos.size) return { files: undefined, ephemeral: [], missing: [] };
    const map: Record<string, ProviderFileEntry> = {};
    const ephemeral: ProviderFileRef[] = [];
    const missing: string[] = [];
    try {
        await runWithConcurrency(
            [...infos],
            PROVIDER_UPLOAD_CONCURRENCY,
            async ([hash, info]) => {
                signal?.throwIfAborted();
                if (fileTooLargeForProvider(provider, info.sizeBytes)) {
                    if (requiredHashes.has(hash))
                        throw new Error(
                            `${info.filename} is too large for ${provider}. Remove it before sending.`
                        );
                    missing.push(hash);
                    log.info(
                        'skipping provider upload, file exceeds provider limit',
                        provider,
                        info.filename,
                        info.sizeBytes
                    );
                    return;
                }
                let entry = persistent
                    ? await dbLookupProviderFile(hash, provider)
                    : undefined;
                if (entry && replicaFresh(entry)) {
                    map[hash] = entry;
                    return;
                }
                const blob = await dbGetFileBlob(hash);
                if (!blob) {
                    if (requiredHashes.has(hash)) {
                        throw new Error(
                            `${info.filename} is unavailable. Reattach it before sending.`
                        );
                    }
                    missing.push(hash);
                    return;
                }
                if (!FILE_PROVIDERS.has(provider)) return;
                log.info('uploading file to provider', provider, hash);
                if (persistent) {
                    entry = await uploadWithDedup(
                        hash,
                        provider,
                        apiKey,
                        blob,
                        blob.type || info.mediaType,
                        info.filename,
                        signal
                    );
                } else {
                    entry = await uploadProviderBlob(
                        provider,
                        apiKey,
                        blob,
                        blob.type || info.mediaType,
                        info.filename,
                        signal
                    );
                    ephemeral.push({
                        providerId: provider,
                        fileId: entry.fileId,
                    });
                }
                map[hash] = entry;
            }
        );
    } catch (error) {
        const warnings = await deleteTemporaryProviderFiles(ephemeral, apiKey);
        if (!warnings.length) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message}\n${warnings.join('\n')}`, {
            cause: error,
        });
    }
    return {
        files: Object.keys(map).length ? map : undefined,
        ephemeral,
        missing,
    };
}

export async function recoverRejectedProviderFiles(
    error: unknown,
    provider: string,
    files: Record<string, ProviderFileEntry> | undefined
): Promise<boolean> {
    if (!(error instanceof Error) || !files || !('status' in error))
        return false;
    if (error.status !== 400 && error.status !== 403 && error.status !== 404)
        return false;
    const message = error.message.toLowerCase();
    if (
        !/not[ _-]?found|does not exist|cannot (?:find|access)|could not (?:find|access)|inaccessible|permission|access denied|not authorized|expired/.test(
            message
        )
    )
        return false;
    const rejected = Object.values(files).filter(
        (file) =>
            message.includes(file.fileId.toLowerCase()) ||
            (file.fileId.startsWith('files/') &&
                message.includes(file.fileId.slice(6).toLowerCase())) ||
            (file.uri !== undefined && message.includes(file.uri.toLowerCase()))
    );
    if (!rejected.length) return false;
    for (const file of rejected)
        await dbForgetProviderFile(provider, file.fileId);
    return true;
}
