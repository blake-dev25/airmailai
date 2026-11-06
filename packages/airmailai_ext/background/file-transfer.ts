import type {
    DraftAttachment,
    FileTransferRequest,
    FileTransferResponse,
} from '@airmailai/shared';
import { FILE_TRANSFER_CHUNK_BYTES } from '@airmailai/shared';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { log } from '../debug';
import { dbGetFileBlob, dbStageDraftAttachment } from '../storage/db';
import { base64ToBytes, bytesToBase64 } from '../storage/encoding';
import { broadcastTo, releaseStreamPort, trackStreamPort } from './ports';
import {
    FILE_PROVIDERS,
    readApiKey,
    uploadWithDedup,
} from './provider-file-sync';

async function replicateDraftAttachment(
    chatId: string,
    provider: string,
    attachment: DraftAttachment,
    blob: Blob,
    sourceTabId: string | undefined
): Promise<void> {
    try {
        const apiKey = await readApiKey(provider);
        if (!apiKey) {
            throw new Error(`No API key saved for ${provider}.`);
        }
        await uploadWithDedup(
            attachment.hash,
            provider,
            apiKey,
            blob,
            attachment.mediaType,
            attachment.name
        );
    } catch (error) {
        log.error('draft replica upload failed', error);
        broadcastTo(
            {
                type: 'replica-warning',
                chatId,
                provider,
                filename: attachment.name,
                message: error instanceof Error ? error.message : String(error),
            },
            sourceTabId
        );
    }
}

type UploadStartRequest = Extract<
    FileTransferRequest,
    { type: 'upload_start' }
>;

type TransferState =
    | { kind: 'idle' }
    | {
          kind: 'uploading';
          request: UploadStartRequest;
          hasher: ReturnType<typeof sha256.create>;
          chunks: Blob[];
          nextIndex: number;
      }
    | { kind: 'upload-saved' }
    | { kind: 'downloading'; blob: Blob; chunkCount: number }
    | { kind: 'download-missing' }
    | { kind: 'failed' };

export function handleFileTransferPort(port: chrome.runtime.Port): void {
    log.info('file transfer port connected');
    trackStreamPort(port);
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
        const message = error instanceof Error ? error.message : String(error);
        log.error('file transfer failed', error);
        send({ type: 'error', message });
    };

    const startUpload = (message: UploadStartRequest) => {
        if (state.kind !== 'idle') {
            throw new Error('File transfer already started.');
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
        transition({ kind: 'upload-saved' });
        await dbStageDraftAttachment(request.chatId, attachment, blob);
        send({ type: 'upload_saved', hash: attachment.hash });
        if (request.replicateTo && FILE_PROVIDERS.has(request.replicateTo)) {
            void replicateDraftAttachment(
                request.chatId,
                request.replicateTo,
                attachment,
                blob,
                request.sourceTabId
            );
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
        releaseStreamPort(port);
    });
}
