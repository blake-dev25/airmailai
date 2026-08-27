import type {
    AirmailAIChunk,
    AirmailAIMessage,
    ExtensionStreamEvent,
    HydratedStoredMessage,
    ProviderFileEntry,
    ProviderFileRef,
    StreamErrorSource,
    TurnRequest,
} from '@airmailai/shared';
import { applyAirmailAIChunk, createMessageAssembler } from '@airmailai/shared';
import { log } from '../debug';
import {
    downloadOpenAIContainerFile,
    listOpenAIContainerFiles,
} from '../providers/openai-container-files';
import { streamProvider } from '../providers/stream';
import {
    dbGetFileBlob,
    dbGetMeta,
    dbPutMessage,
    dbRecordProviderFile,
    dbSetContainer,
} from '../storage/db';
import { bytesToBase64, hashBytes } from '../storage/encoding';
import { broadcast, releaseStreamPort, trackStreamPort } from './ports';
import {
    FILE_PROVIDERS,
    deleteProviderFile,
    deleteProviderFiles,
    deleteTemporaryProviderFiles,
    fileTooLargeForProvider,
    prepareProviderFiles,
    readApiKey,
    readProviderFileStorageEnabled,
    uploadWithDedup,
} from './provider-file-sync';

const inflightTurns = new Set<string>();

interface OpenAICaptureResult {
    freshBlobs: HydratedStoredMessage['freshBlobs'];
    containerFileIds: string[];
    warning?: string;
}

async function captureOpenAIOutputs(
    message: AirmailAIMessage,
    chatId: string,
    apiKey: string,
    containerId: string,
    storageOn: boolean,
    signal: AbortSignal
): Promise<OpenAICaptureResult> {
    const meta = await dbGetMeta(chatId);
    const captured = new Set(
        meta?.containerId === containerId ? (meta.containerFileIds ?? []) : []
    );
    const files = await listOpenAIContainerFiles(apiKey, containerId, signal);
    const freshBlobs: Record<string, { mediaType: string; base64: string }> =
        {};
    const capturedParts: AirmailAIMessage['parts'] = [];
    const containerFileIds: string[] = [];
    const warnings: string[] = [];
    for (const f of files) {
        if (f.source !== 'assistant') continue;
        if (captured.has(f.fileId)) {
            containerFileIds.push(f.fileId);
            continue;
        }
        if (signal.aborted) break;
        let buf: ArrayBuffer;
        try {
            buf = await downloadOpenAIContainerFile(
                apiKey,
                containerId,
                f.fileId,
                signal
            );
        } catch (err) {
            if (signal.aborted) break;
            throw err;
        }
        const bytes = new Uint8Array(buf);
        const hash = await hashBytes(buf);
        freshBlobs[hash] = {
            mediaType: f.mediaType,
            base64: bytesToBase64(bytes),
        };
        capturedParts.push({
            type: 'file',
            filename: f.filename,
            mediaType: f.mediaType,
            sizeBytes: bytes.byteLength,
            hash,
        });
        containerFileIds.push(f.fileId);
        if (fileTooLargeForProvider('openai', bytes.byteLength)) {
            log.info(
                'skipping provider replica, file exceeds provider limit',
                f.filename,
                bytes.byteLength
            );
            continue;
        }
        if (storageOn) {
            try {
                await uploadWithDedup(
                    hash,
                    'openai',
                    apiKey,
                    new Blob([bytes], { type: f.mediaType }),
                    f.mediaType,
                    f.filename,
                    signal
                );
            } catch (err) {
                if (signal.aborted) break;
                log.error('output replica upload failed', err);
                warnings.push(
                    `${f.filename}: ${err instanceof Error ? err.message : String(err)}`
                );
            }
        }
    }
    message.parts.push(...capturedParts);
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
    messages: AirmailAIMessage[],
    provider: string,
    replicas: Record<string, ProviderFileEntry> | undefined
): Promise<Record<string, { mediaType: string; base64: string }>> {
    const parts = new Map<string, { mediaType: string; sizeBytes: number }>();
    for (const m of messages) {
        for (const part of m.parts) {
            if (part.type === 'file') {
                parts.set(part.hash, {
                    mediaType: part.mediaType,
                    sizeBytes: part.sizeBytes,
                });
            }
        }
    }
    const blobs: Record<string, { mediaType: string; base64: string }> = {};
    for (const [hash, { mediaType, sizeBytes }] of parts) {
        if (fileTooLargeForProvider(provider, sizeBytes)) {
            continue;
        }
        const replica = replicas?.[hash];
        if (replica && replicaUsableWithoutBytes(provider, replica)) {
            continue;
        }
        const blob = await dbGetFileBlob(hash);
        if (blob) {
            blobs[hash] = {
                mediaType: blob.type || mediaType,
                base64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())),
            };
        }
    }
    return blobs;
}

function truncateAssistantParts(msg: AirmailAIMessage, maxChars: number): void {
    let textConsumed = 0;
    let i = 0;
    while (i < msg.parts.length) {
        const part = msg.parts[i];
        if (!part) break;
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

export function handleTurnPort(port: chrome.runtime.Port): void {
    log.info('turn port connected');
    trackStreamPort(port);
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
    let errorSource: StreamErrorSource = 'extension';
    let portOpen = true;
    let truncateTo: number | null = null;

    const send = (event: ExtensionStreamEvent) => {
        if (portOpen) port.postMessage(event);
    };

    port.onDisconnect.addListener(() => {
        portOpen = false;
        log.info('port disconnected, disposition:', disposition);
        if (disposition === 'pending' || disposition === 'streaming') {
            disposition = 'aborted';
            if (lockedChatId) inflightTurns.delete(lockedChatId);
        }
        controller.abort();
        releaseStreamPort(port);
    });

    port.onMessage.addListener(async (msg: TurnRequest) => {
        if (msg.type === 'stop') {
            if (disposition !== 'streaming' && disposition !== 'completed')
                return;
            log.info('stop received', 'truncateTo:', msg.truncateTo);
            if (disposition === 'streaming') {
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
            }
            controller.abort();
            return;
        }

        if (disposition !== 'pending') return;

        if (inflightTurns.has(msg.chatId)) {
            log.info('lock taken, rejecting', msg.chatId);
            send({
                type: 'error',
                source: 'extension',
                message: 'Conversation active in another tab.',
            });
            if (portOpen) port.disconnect();
            releaseStreamPort(port);
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
                assistantMessageId: msg.assistantMessageId,
                assistantCreatedAt: msg.assistantCreatedAt,
            },
            msg.sourceTabId
        );

        const assembler = createMessageAssembler({
            id: msg.assistantMessageId,
            role: 'assistant',
            parts: [],
            metadata: { createdAt: msg.assistantCreatedAt },
        });

        let capturedContainerId: string | undefined;
        let capturedContainerExpiresAt: string | undefined;
        let storageOn = false;
        let apiKey: string | undefined;
        let ephemeralInputFiles: ProviderFileRef[] = [];
        const outputWarnings: string[] = [];
        const streamOutputBlobs: Record<
            string,
            { mediaType: string; base64: string }
        > = {};

        try {
            apiKey = await readApiKey(msg.provider);
            if (!apiKey) {
                log.error('no API key for provider', msg.provider);
                inStreamErrorText = `No API key saved for ${msg.provider}. Add one in Settings.`;
                errorSource = 'extension';
                disposition = 'errored';
                return;
            }

            log.info('streaming', msg.chatId, {
                provider: msg.provider,
                model: msg.model,
                messages: msg.messages.length,
            });

            log.debug('site -> ext request', {
                provider: msg.provider,
                model: msg.model,
                params: msg.params,
                system: msg.system,
                messages: msg.messages,
            });

            storageOn = await readProviderFileStorageEnabled();
            let providerFiles: Record<string, ProviderFileEntry> | undefined;
            if (FILE_PROVIDERS.has(msg.provider)) {
                const prepared = await prepareProviderFiles(
                    msg.messages,
                    msg.provider,
                    apiKey,
                    storageOn,
                    controller.signal
                );
                providerFiles = prepared.files;
                ephemeralInputFiles = prepared.ephemeral;
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
                        new Date(meta.containerExpiresAt).getTime() - 60_000 >
                            Date.now()
                    ) {
                        turnParams = {
                            ...turnParams,
                            container: meta.containerId,
                        };
                        log.info('reusing container', meta.containerId);
                    }
                }
            }

            let chunkStream: AsyncIterable<AirmailAIChunk>;
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
                log.error('streamProvider threw', e);
                inStreamErrorText = e instanceof Error ? e.message : String(e);
                errorSource = 'extension';
                disposition = 'errored';
                return;
            }

            errorSource = 'api';
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
                            log.error('output replica policy failed', err);
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
                applyAirmailAIChunk(assembler, chunk);
                if (chunk.type === 'finish') {
                    if (chunk.containerId)
                        capturedContainerId = chunk.containerId;
                    if (chunk.containerExpiresAt)
                        capturedContainerExpiresAt = chunk.containerExpiresAt;
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
            errorSource = 'extension';

            if (disposition === 'streaming') {
                disposition = 'completed';
            }
        } catch (e: unknown) {
            log.error('stream threw', e);
            if (disposition === 'streaming') {
                inStreamErrorText = e instanceof Error ? e.message : String(e);
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
                const finalMessage: AirmailAIMessage = {
                    ...assembled,
                    id: assistantMessageId,
                    role: 'assistant',
                    metadata: {
                        createdAt: msg.assistantCreatedAt,
                        model: `${msg.provider}/${msg.model}`,
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
                            storageOn,
                            controller.signal
                        );
                        freshBlobs = captured.freshBlobs;
                        containerFileIds = captured.containerFileIds;
                        if (captured.warning) {
                            outputWarnings.push(
                                `Saved generated file(s) on this device, but couldn't copy to OpenAI storage (will retry on your next message): ${captured.warning}`
                            );
                        }
                    } catch (err) {
                        if (controller.signal.aborted) {
                            log.info('output capture aborted by stop');
                        } else {
                            log.error('output capture failed', err);
                            inStreamErrorText = `Couldn't download generated file(s): ${err instanceof Error ? err.message : String(err)}`;
                            disp = 'errored';
                        }
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
                    log.error('save failed', err);
                    const m = err instanceof Error ? err.message : String(err);
                    inStreamErrorText = `Couldn't save assistant message: ${m}`;
                    errorSource = 'extension';
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
                        log.error('container persist failed', err);
                    }
                }
            }

            if (apiKey && ephemeralInputFiles.length) {
                outputWarnings.push(
                    ...(await deleteTemporaryProviderFiles(
                        ephemeralInputFiles,
                        apiKey
                    ))
                );
            }

            if (outputWarnings.length && disp !== 'errored') {
                inStreamErrorText = outputWarnings.join('\n');
                disp = 'errored';
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
                            source: errorSource,
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
            releaseStreamPort(port);
        }
    });
}
