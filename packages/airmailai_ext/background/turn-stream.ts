import type {
    AirmailAIChunk,
    StreamErrorSource,
    TurnStartRequest,
} from '@airmailai/shared';
import { applyAirmailAIChunk, errorMessage } from '@airmailai/shared';
import { log } from '../debug';
import { hasReplayableContent } from '../providers/fold-replay';
import { streamProvider } from '../providers/stream';
import { dbGetMeta, dbLoadChat, dbRecordProviderFile } from '../storage/db';
import { base64ToBytes } from '../storage/encoding';
import { broadcast } from './ports';
import {
    deleteProviderFile,
    prepareProviderFiles,
    readApiKey,
    readProviderFileStorageEnabled,
    recoverRejectedProviderFiles,
} from './provider-file-sync';
import { replayAssistantFiles } from './turn-files';
import type { TurnProgress, TurnSession } from './turn-session';

const TEXT_PART_SEPARATOR = '\n\n';
const TEXT_SEPARATOR_ID_PREFIX = 'separator:';
const CONTAINER_REUSE_MARGIN_MS = 60_000;

async function resolveTurnParams(
    request: TurnStartRequest
): Promise<Record<string, unknown>> {
    const params = request.params ?? {};
    if (request.provider === 'google') return params;
    const wireTools = (params.tools ?? {}) as Record<string, unknown>;
    if (!wireTools.codeExecution) return params;
    const meta = await dbGetMeta(request.chatId);
    if (
        meta?.containerId &&
        meta.containerProvider === request.provider &&
        meta.containerExpiresAt &&
        new Date(meta.containerExpiresAt).getTime() -
            CONTAINER_REUSE_MARGIN_MS >
            Date.now()
    ) {
        log.info('reusing container', meta.containerId);
        return { ...params, container: meta.containerId };
    }
    return params;
}

function textSeparatorChunks(textId: string): AirmailAIChunk[] {
    const id = `${TEXT_SEPARATOR_ID_PREFIX}${textId}`;
    return [
        { type: 'text-start', id },
        { type: 'text-delta', id, delta: TEXT_PART_SEPARATOR },
        { type: 'text-end', id },
    ];
}

export async function streamTurn(
    session: TurnSession,
    progress: TurnProgress
): Promise<void> {
    const { request, lifecycle, signal, send } = session;
    const { assembler } = progress;
    let activeSource: StreamErrorSource = 'extension';

    try {
        const storedChat = await dbLoadChat(request.chatId);
        if (!storedChat) throw new Error('The conversation was deleted.');
        progress.chatRevision = storedChat.revision;
        const messages = storedChat.messages.map((row) => row.message);
        const apiKey = await readApiKey(request.provider);
        if (!apiKey) {
            log.error('no API key for provider', request.provider);
            lifecycle.streamFailed(
                `No API key saved for ${request.provider}. Add one in Settings.`,
                'extension'
            );
            return;
        }
        progress.apiKey = apiKey;

        log.info('streaming', request.chatId, {
            provider: request.provider,
            model: request.model,
            messages: messages.length,
        });

        log.debug('site -> ext request', {
            provider: request.provider,
            model: request.model,
            params: request.params,
            system: request.system,
            messages,
        });

        const storageOn = await readProviderFileStorageEnabled();
        progress.storageOn = storageOn;

        const turnParams = await resolveTurnParams(request);
        const wireTools = turnParams.tools as
            { codeExecution?: unknown } | undefined;
        const replay = replayAssistantFiles(
            messages,
            request.provider,
            storageOn,
            !!wireTools?.codeExecution
        );

        const lastUserMessage = messages.findLast((m) => m.role === 'user');
        const requiredHashes = new Set(
            lastUserMessage?.parts.flatMap((p) =>
                p.type === 'file' ? [p.hash] : []
            ) ?? []
        );
        const generateChunks =
            async function* (): AsyncGenerator<AirmailAIChunk> {
                let canRecover = storageOn;
                for (;;) {
                    signal.throwIfAborted();
                    activeSource = 'extension';
                    const prepared = await prepareProviderFiles(
                        replay,
                        request.provider,
                        apiKey,
                        storageOn,
                        signal,
                        requiredHashes
                    );
                    const missing = new Set(prepared.missing);
                    const availableMessages = replay
                        .map((m) => ({
                            ...m,
                            parts: m.parts.filter(
                                (p) => p.type !== 'file' || !missing.has(p.hash)
                            ),
                        }))
                        .filter(hasReplayableContent);
                    const stream = streamProvider(request.provider, {
                        apiKey,
                        model: request.model,
                        messages: availableMessages,
                        system: request.system,
                        params: turnParams,
                        signal,
                        blobs: prepared.blobs,
                        providerFiles: prepared.files,
                    });
                    activeSource = 'api';
                    try {
                        for await (const chunk of stream) {
                            canRecover = false;
                            yield chunk;
                        }
                        return;
                    } catch (error) {
                        if (
                            !canRecover ||
                            signal.aborted ||
                            !(await recoverRejectedProviderFiles(
                                error,
                                request.provider,
                                prepared.files
                            ))
                        )
                            throw error;
                        canRecover = false;
                        broadcast({
                            type: 'files-changed',
                            chatIds: [request.chatId],
                        });
                    }
                }
            };

        const deliver = (chunk: AirmailAIChunk, outbound: AirmailAIChunk) => {
            applyAirmailAIChunk(assembler, chunk);
            if (!lifecycle.isDelivering()) return;
            send({ type: 'chunk', chunk: outbound });
            broadcast(
                {
                    type: 'turn-chunk',
                    chatId: request.chatId,
                    chunk: outbound,
                },
                request.sourceTabId
            );
        };

        let textInterrupted = false;
        let finished = false;
        for await (const chunk of generateChunks()) {
            let outbound = chunk;
            if (chunk.type === 'file' && chunk.base64) {
                progress.outputBlobs.set(
                    chunk.hash,
                    new Blob([base64ToBytes(chunk.base64)], {
                        type: chunk.mediaType,
                    })
                );
                if (chunk.replicaFileId) {
                    try {
                        if (storageOn) {
                            await dbRecordProviderFile(
                                chunk.hash,
                                request.provider,
                                { fileId: chunk.replicaFileId },
                                chunk.filename,
                                chunk.mediaType
                            );
                        } else {
                            await deleteProviderFile(
                                request.provider,
                                apiKey,
                                chunk.replicaFileId
                            );
                        }
                    } catch (err) {
                        log.error('output replica policy failed', err);
                        const m = errorMessage(err);
                        progress.outputWarnings.push(
                            storageOn
                                ? `Couldn't record a provider copy of ${chunk.filename} (will retry on your next message): ${m}`
                                : `Couldn't delete ${chunk.filename} from ${request.provider} storage (you can delete it from the Files tab): ${m}`
                        );
                    }
                }
                const stripped = { ...chunk };
                delete stripped.base64;
                delete stripped.replicaFileId;
                outbound = stripped;
            }
            if (chunk.type === 'finish') {
                finished = true;
                if (chunk.containerId) {
                    progress.container = {
                        id: chunk.containerId,
                        expiresAt: chunk.containerExpiresAt,
                    };
                }
            }
            if (
                chunk.type === 'tool-call' ||
                chunk.type === 'reasoning-start' ||
                chunk.type === 'file'
            ) {
                textInterrupted = true;
            }
            if (chunk.type === 'text-start') {
                const hadTextBefore = assembler.message.parts.some(
                    (p) => p.type === 'text' && p.text.length > 0
                );
                if (hadTextBefore && textInterrupted) {
                    for (const separatorChunk of textSeparatorChunks(
                        chunk.id
                    )) {
                        deliver(separatorChunk, separatorChunk);
                    }
                }
                textInterrupted = false;
            }
            deliver(chunk, outbound);
        }
        activeSource = 'extension';
        if (finished) {
            lifecycle.streamEnded();
        } else {
            lifecycle.streamFailed(
                'The response ended before it was complete.',
                'api'
            );
        }
    } catch (e: unknown) {
        log.error('stream threw', e);
        lifecycle.streamFailed(errorMessage(e), activeSource);
    }
}
