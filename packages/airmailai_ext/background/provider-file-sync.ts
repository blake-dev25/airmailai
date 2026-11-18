import type {
    AirmailAIMessage,
    ProviderFileEntry,
    ProviderFileRef,
    ProviderId,
} from '@airmailai/shared';
import {
    PROVIDER_INLINE_MAX_REQUEST_BYTES,
    errorMessage,
    isProviderId,
    providerMaxFileBytes,
} from '@airmailai/shared';
import { log } from '../debug';
import { bytesToBase64 } from '../storage/encoding';
import {
    deleteAnthropicFile,
    uploadAnthropicFile,
} from '../providers/anthropic-files';
import { deleteOpenAIFile, uploadOpenAIFile } from '../providers/openai-files';
import { deleteGoogleFile, uploadGoogleFile } from '../providers/google-files';
import {
    deleteOpenRouterFile,
    openRouterStoresMediaType,
    uploadOpenRouterFile,
} from '../providers/openrouter-files';
import {
    dbForgetProviderFile,
    dbGetFileBlob,
    dbLookupProviderFile,
    dbRecordProviderFile,
} from '../storage/db';

const API_KEY_PREFIX = 'apiKey_';

export function apiKeyName(provider: ProviderId): string {
    assertKnownProvider(provider);
    return `${API_KEY_PREFIX}${provider}`;
}

export async function readApiKey(
    provider: ProviderId
): Promise<string | undefined> {
    const key = apiKeyName(provider);
    const result = await chrome.storage.local.get(key);
    return result[key] as string | undefined;
}

export async function readProviderFileStorageEnabled(): Promise<boolean> {
    const result = await chrome.storage.sync.get('enableProviderFileStorage');
    return result.enableProviderFileStorage === true;
}

function httpStatus(error: unknown): number | undefined {
    if (!(error instanceof Error)) return undefined;
    if ('status' in error && typeof error.status === 'number') {
        return error.status;
    }
    if ('statusCode' in error && typeof error.statusCode === 'number') {
        return error.statusCode;
    }
    return undefined;
}

export function providerStoresFile(
    provider: ProviderId,
    mediaType: string,
    providerFileStorage: boolean
): boolean {
    if (!providerFileStorage) return false;
    return provider !== 'openrouter' || openRouterStoresMediaType(mediaType);
}

async function deleteRemoteProviderFile(
    providerId: ProviderId,
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
        } else if (providerId === 'openrouter') {
            await deleteOpenRouterFile(apiKey, fileId);
        } else {
            throw new Error('Unknown file provider.');
        }
    } catch (error) {
        if (httpStatus(error) !== 404) throw error;
    }
}

export async function deleteProviderFile(
    providerId: ProviderId,
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
    const byProvider = new Map<ProviderId, string[]>();
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
                        `Couldn't delete an unused ${providerId} file (${fileId}): ${errorMessage(err)}. You can remove it from the Files tab.`
                    );
                }
            })
        );
    }
    return warnings;
}

export function fileTooLargeForProvider(
    provider: ProviderId,
    sizeBytes: number,
    providerFileStorage: boolean
): boolean {
    return sizeBytes > providerMaxFileBytes(provider, providerFileStorage);
}

export function assertKnownProvider(
    provider: unknown
): asserts provider is ProviderId {
    if (!isProviderId(provider)) {
        throw new Error('Unknown provider.');
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

export class DraftFileStorageDisabled extends Error {}

export function uploadWithDedup(
    hash: string,
    provider: ProviderId,
    apiKey: string,
    blob: Blob,
    mediaType: string,
    filename: string,
    signal?: AbortSignal,
    source: 'draft' | 'turn' = 'turn'
): Promise<ProviderFileEntry> {
    const key = `${provider}:${hash}`;
    const inflight = inflightProviderUploads.get(key);
    if (inflight) {
        log.info('dedup: joining in-flight provider upload', key);
        if (source === 'draft') return inflight;
        return inflight.catch((error: unknown) => {
            if (!(error instanceof DraftFileStorageDisabled)) throw error;
            return uploadWithDedup(
                hash,
                provider,
                apiKey,
                blob,
                mediaType,
                filename,
                signal
            );
        });
    }
    const task = (async () => {
        const existing = await dbLookupProviderFile(hash, provider);
        if (existing && replicaFresh(existing)) {
            log.info('dedup: reusing provider file', provider, existing.fileId);
            return existing;
        }
        if (source === 'draft' && !(await readProviderFileStorageEnabled()))
            throw new DraftFileStorageDisabled();
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
    })().finally(() => inflightProviderUploads.delete(key));
    inflightProviderUploads.set(key, task);
    return task;
}

async function uploadProviderBlob(
    provider: ProviderId,
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
    if (provider === 'openrouter') {
        return {
            fileId: await uploadOpenRouterFile(apiKey, blob, filename, signal),
        };
    }
    throw new Error('Unknown file provider.');
}

interface PreparedProviderFiles {
    files: Record<string, ProviderFileEntry> | undefined;
    blobs: Record<string, { mediaType: string; base64: string }>;
    missing: string[];
}

const BYTES_PER_MB = 1024 * 1024;

function formatMegabytes(bytes: number): string {
    return `${Math.ceil((bytes / BYTES_PER_MB) * 10) / 10} MB`;
}

function inlineTotalTooLargeError(
    provider: ProviderId,
    totalBytes: number,
    providerFileStorage: boolean
): Error {
    const total = formatMegabytes(totalBytes);
    const limit = formatMegabytes(PROVIDER_INLINE_MAX_REQUEST_BYTES[provider]);
    return new Error(
        providerFileStorage
            ? `Files sent inline in this chat total ${total}, over the ${limit} limit for ${provider}. Delete files from this chat.`
            : `Files in this chat total ${total}, over the ${limit} limit for sending files without Provider File Storage. Turn on Provider File Storage in Settings, or delete files from this chat.`
    );
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
    provider: ProviderId,
    apiKey: string,
    providerFileStorage: boolean,
    signal?: AbortSignal,
    requiredHashes: ReadonlySet<string> = new Set()
): Promise<PreparedProviderFiles> {
    const infos = new Map<
        string,
        {
            filename: string;
            mediaType: string;
            sizeBytes: number;
            occurrences: number;
        }
    >();
    for (const msg of messages) {
        for (const part of msg.parts) {
            if (part.type === 'file') {
                infos.set(part.hash, {
                    occurrences: (infos.get(part.hash)?.occurrences ?? 0) + 1,
                    filename: part.filename,
                    mediaType: part.mediaType,
                    sizeBytes: part.sizeBytes,
                });
            }
        }
    }
    const map: Record<string, ProviderFileEntry> = {};
    const inline = new Map<string, { blob: Blob; mediaType: string }>();
    const missing: string[] = [];
    let inlineBytes = 0;
    await runWithConcurrency(
        [...infos],
        PROVIDER_UPLOAD_CONCURRENCY,
        async ([hash, info]) => {
            signal?.throwIfAborted();
            if (
                fileTooLargeForProvider(
                    provider,
                    info.sizeBytes,
                    providerFileStorage
                )
            ) {
                if (requiredHashes.has(hash))
                    throw new Error(
                        `${info.filename} is too large for ${provider}. Remove it before sending.`
                    );
                missing.push(hash);
                log.info(
                    'skipping file, exceeds provider limit',
                    provider,
                    info.filename,
                    info.sizeBytes
                );
                return;
            }
            const storesFile = providerStoresFile(
                provider,
                info.mediaType,
                providerFileStorage
            );
            if (storesFile) {
                const entry = await dbLookupProviderFile(hash, provider);
                if (entry && replicaFresh(entry)) {
                    map[hash] = entry;
                    if (provider !== 'google' || entry.uri) return;
                }
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
            if (storesFile && !map[hash]) {
                log.info('uploading file to provider', provider, hash);
                const entry = await uploadWithDedup(
                    hash,
                    provider,
                    apiKey,
                    blob,
                    blob.type || info.mediaType,
                    info.filename,
                    signal
                );
                map[hash] = entry;
                if (provider !== 'google' || entry.uri) return;
            }
            inlineBytes += blob.size * info.occurrences;
            inline.set(hash, { blob, mediaType: blob.type || info.mediaType });
        }
    );
    if (inlineBytes > PROVIDER_INLINE_MAX_REQUEST_BYTES[provider]) {
        throw inlineTotalTooLargeError(
            provider,
            inlineBytes,
            providerFileStorage
        );
    }
    const blobs: PreparedProviderFiles['blobs'] = {};
    for (const [hash, { blob, mediaType }] of inline) {
        signal?.throwIfAborted();
        blobs[hash] = {
            mediaType,
            base64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())),
        };
    }
    return {
        files: Object.keys(map).length ? map : undefined,
        blobs,
        missing,
    };
}

export async function recoverRejectedProviderFiles(
    error: unknown,
    provider: ProviderId,
    files: Record<string, ProviderFileEntry> | undefined
): Promise<boolean> {
    if (!(error instanceof Error) || !files) return false;
    const status = httpStatus(error);
    if (status !== 400 && status !== 403 && status !== 404) return false;
    const message = error.message.toLowerCase();
    if (
        !/not[ _-]?found|does not exist|cannot (?:find|access)|could not (?:find|access)|inaccessible|permission|access denied|not authorized|expired|invalid file_id/.test(
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
