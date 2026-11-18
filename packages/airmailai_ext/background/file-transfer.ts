import type {
    DraftAttachment,
    AirmailAIMessage,
    FileTransferRequest,
    FileTransferResponse,
    ProviderFileEntry,
    ProviderId,
} from '@airmailai/shared';
import { FILE_TRANSFER_CHUNK_BYTES, errorMessage } from '@airmailai/shared';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { log } from '../debug';
import {
    dbFileHasChats,
    dbGetFileBlob,
    dbImportChats,
    dbStageDraftAttachment,
} from '../storage/db';
import { base64ToBytes, bytesToBase64 } from '../storage/encoding';
import {
    broadcast,
    broadcastTo,
    holdExtensionUpdate,
    releaseExtensionUpdate,
} from './ports';
import {
    DraftFileStorageDisabled,
    assertKnownProvider,
    deleteProviderFiles,
    providerStoresFile,
    readApiKey,
    readProviderFileStorageEnabled,
    uploadWithDedup,
} from './provider-file-sync';

async function replicateDraftAttachment(
    chatId: string,
    provider: ProviderId,
    attachment: DraftAttachment,
    blob: Blob,
    sourceTabId: string | undefined
): Promise<void> {
    let replica: ProviderFileEntry;
    try {
        const enabled = await readProviderFileStorageEnabled();
        if (!providerStoresFile(provider, attachment.mediaType, enabled))
            return;
        const apiKey = await readApiKey(provider);
        if (!apiKey) {
            throw new Error(`No API key saved for ${provider}.`);
        }
        replica = await uploadWithDedup(
            attachment.hash,
            provider,
            apiKey,
            blob,
            attachment.mediaType,
            attachment.name,
            undefined,
            'draft'
        );
    } catch (error) {
        if (error instanceof DraftFileStorageDisabled) return;
        log.error('draft replica upload failed', error);
        broadcastTo(
            {
                type: 'replica-warning',
                chatId,
                provider,
                filename: attachment.name,
                message: errorMessage(error),
            },
            sourceTabId
        );
        return;
    }
    await deleteReplicaIfUnreferenced(
        chatId,
        provider,
        attachment.hash,
        replica.fileId,
        sourceTabId
    );
}

async function deleteReplicaIfUnreferenced(
    chatId: string,
    provider: ProviderId,
    hash: string,
    fileId: string,
    sourceTabId: string | undefined
): Promise<void> {
    try {
        if (await dbFileHasChats(hash)) return;
        log.info('draft removed during replica upload, deleting', fileId);
        const warnings = await deleteProviderFiles([
            { providerId: provider, fileId },
        ]);
        if (warnings.length) throw new Error(warnings.join('\n'));
    } catch (error) {
        log.error('unreferenced draft replica cleanup failed', error);
        broadcastTo(
            {
                type: 'turn-warning',
                chatId,
                message: errorMessage(error),
            },
            sourceTabId
        );
    }
}

type UploadStartRequest = Extract<
    FileTransferRequest,
    { type: 'upload_start' }
>;

const MAX_IMPORT_TRANSFER_CHARS = 128 * 1024 * 1024;

type TransferState =
    | { kind: 'idle' }
    | {
          kind: 'uploading';
          request: UploadStartRequest;
          hasher: ReturnType<typeof sha256.create>;
          chunks: Blob[];
          nextIndex: number;
      }
    | { kind: 'saved' }
    | { kind: 'importing'; messages: AirmailAIMessage[]; chars: number }
    | { kind: 'downloading'; blob: Blob; chunkCount: number }
    | { kind: 'download-missing' }
    | { kind: 'failed' };

export function handleFileTransferPort(port: chrome.runtime.Port): void {
    log.info('file transfer port connected');
    holdExtensionUpdate(port);
    let state: TransferState = { kind: 'idle' };
    let portOpen = true;
    let work = Promise.resolve();

    const send = (response: FileTransferResponse) => {
        if (portOpen) port.postMessage(response);
    };

    const transition = (next: TransferState) => {
        if (state.kind === 'uploading') state.hasher.destroy();
        state = next;
    };

    const fail = (error: unknown) => {
        transition({ kind: 'failed' });
        log.error('file transfer failed', error);
        send({ type: 'error', message: errorMessage(error) });
    };

    const startUpload = (message: UploadStartRequest) => {
        if (state.kind !== 'idle') {
            throw new Error('File transfer already started.');
        }
        if (message.replicateTo !== undefined) {
            assertKnownProvider(message.replicateTo);
        }
        const expectedChunks = Math.ceil(
            message.attachment.sizeBytes / FILE_TRANSFER_CHUNK_BYTES
        );
        if (message.chunkCount !== expectedChunks) {
            throw new Error('Invalid file transfer chunk count.');
        }
        transition({
            kind: 'uploading',
            request: message,
            hasher: sha256.create(),
            chunks: [],
            nextIndex: 0,
        });
        send({ type: 'upload_ready' });
    };

    const receiveUploadChunk = (index: number, base64: string) => {
        if (state.kind !== 'uploading') {
            throw new Error('File upload has not started.');
        }
        const { request } = state;
        if (index !== state.nextIndex || index >= request.chunkCount) {
            throw new Error('File chunks arrived out of order.');
        }
        const bytes = base64ToBytes(base64);
        const expectedBytes = Math.min(
            FILE_TRANSFER_CHUNK_BYTES,
            request.attachment.sizeBytes - index * FILE_TRANSFER_CHUNK_BYTES
        );
        if (bytes.byteLength !== expectedBytes) {
            throw new Error('File chunk size does not match the source file.');
        }
        state.hasher.update(bytes);
        state.chunks.push(new Blob([bytes]));
        state.nextIndex++;
        send({ type: 'upload_chunk_saved', index });
    };

    const completeUpload = async () => {
        if (state.kind !== 'uploading') {
            throw new Error('File upload has not started.');
        }
        const { request } = state;
        if (state.nextIndex !== request.chunkCount) {
            throw new Error('File upload is incomplete.');
        }
        const blob = new Blob(state.chunks, {
            type: request.attachment.mediaType,
        });
        if (blob.size !== request.attachment.sizeBytes) {
            throw new Error(
                'Transferred file size does not match the source file.'
            );
        }
        const attachment: DraftAttachment = {
            ...request.attachment,
            hash: bytesToHex(state.hasher.digest()),
        };
        transition({ kind: 'saved' });
        const meta = await dbStageDraftAttachment(
            request.chatId,
            attachment,
            blob
        );
        send({ type: 'upload_saved', hash: attachment.hash });
        if (meta)
            broadcast({ type: 'meta-changed', meta }, request.sourceTabId);
        if (request.replicateTo !== undefined) {
            const replication = {};
            holdExtensionUpdate(replication);
            void replicateDraftAttachment(
                request.chatId,
                request.replicateTo,
                attachment,
                blob,
                request.sourceTabId
            ).finally(() => releaseExtensionUpdate(replication));
        }
    };

    const startDownload = async (hash: string) => {
        if (state.kind !== 'idle') {
            throw new Error('File transfer already started.');
        }
        const blob = await dbGetFileBlob(hash);
        if (!blob) {
            transition({ kind: 'download-missing' });
            send({ type: 'download_missing' });
            return;
        }
        const chunkCount = Math.ceil(blob.size / FILE_TRANSFER_CHUNK_BYTES);
        transition({ kind: 'downloading', blob, chunkCount });
        send({
            type: 'download_ready',
            mediaType: blob.type,
            sizeBytes: blob.size,
            chunkCount,
        });
    };

    const sendDownloadChunk = async (index: number) => {
        if (state.kind !== 'downloading') {
            throw new Error('File download has not started.');
        }
        if (index < 0 || index >= state.chunkCount) {
            throw new Error('Invalid file download chunk.');
        }
        const start = index * FILE_TRANSFER_CHUNK_BYTES;
        const bytes = new Uint8Array(
            await state.blob
                .slice(start, start + FILE_TRANSFER_CHUNK_BYTES)
                .arrayBuffer()
        );
        send({ type: 'download_chunk', index, base64: bytesToBase64(bytes) });
    };

    const handle = async (message: FileTransferRequest) => {
        if (state.kind === 'failed') return;
        switch (message.type) {
            case 'import_messages': {
                if (state.kind === 'idle')
                    state = { kind: 'importing', messages: [], chars: 0 };
                if (state.kind !== 'importing')
                    throw new Error('Chat import already finished.');
                state.chars += JSON.stringify(message.messages).length;
                if (state.chars > MAX_IMPORT_TRANSFER_CHARS)
                    throw new Error('Chat is too large to import.');
                for (const item of message.messages) state.messages.push(item);
                if (message.finalMeta) {
                    const messages = state.messages;
                    transition({ kind: 'saved' });
                    const metas = await dbImportChats([
                        { meta: message.finalMeta, messages },
                    ]);
                    broadcast(
                        { type: 'chats-imported', metas },
                        message.sourceTabId
                    );
                }
                send({ type: 'import_ack' });
                return;
            }
            case 'upload_start':
                startUpload(message);
                return;
            case 'upload_chunk':
                receiveUploadChunk(message.index, message.base64);
                return;
            case 'upload_complete':
                await completeUpload();
                return;
            case 'download_start':
                await startDownload(message.hash);
                return;
            case 'download_chunk':
                await sendDownloadChunk(message.index);
                return;
        }
    };

    port.onMessage.addListener((message: FileTransferRequest) => {
        work = work.then(() => handle(message)).catch(fail);
    });
    port.onDisconnect.addListener(() => {
        portOpen = false;
        transition({ kind: 'failed' });
        releaseExtensionUpdate(port);
    });
}
