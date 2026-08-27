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

export function handleFileTransferPort(port: chrome.runtime.Port): void {
    log.info('file transfer port connected');
    trackStreamPort(port);
    let upload:
        Extract<FileTransferRequest, { type: 'upload_start' }> | undefined;
    let uploadChunks: Blob[] = [];
    let hasher: ReturnType<typeof sha256.create> | null = null;
    let nextUploadIndex = 0;
    let downloadBlob: Blob | null = null;
    let failed = false;
    let portOpen = true;
    let work = Promise.resolve();

    const send = (response: FileTransferResponse) => {
        if (portOpen) port.postMessage(response);
    };

    const releaseUploadState = () => {
        hasher?.destroy();
        hasher = null;
        uploadChunks = [];
    };

    const fail = (error: unknown) => {
        failed = true;
        releaseUploadState();
        const message = error instanceof Error ? error.message : String(error);
        log.error('file transfer failed', error);
        send({ type: 'error', message });
    };

    const handle = async (message: FileTransferRequest) => {
        if (failed) return;
        if (message.type === 'upload_start') {
            if (upload || downloadBlob) {
                throw new Error('File transfer already started.');
            }
            const expectedChunks = Math.ceil(
                message.attachment.sizeBytes / FILE_TRANSFER_CHUNK_BYTES
            );
            if (message.chunkCount !== expectedChunks) {
                throw new Error('Invalid file transfer chunk count.');
            }
            upload = message;
            hasher = sha256.create();
            send({ type: 'upload_ready' });
            return;
        }
        if (message.type === 'upload_chunk') {
            if (!upload || !hasher) {
                throw new Error('File upload has not started.');
            }
            if (
                message.index !== nextUploadIndex ||
                message.index >= upload.chunkCount
            ) {
                throw new Error('File chunks arrived out of order.');
            }
            const bytes = base64ToBytes(message.base64);
            const expectedBytes = Math.min(
                FILE_TRANSFER_CHUNK_BYTES,
                upload.attachment.sizeBytes -
                    message.index * FILE_TRANSFER_CHUNK_BYTES
            );
            if (bytes.byteLength !== expectedBytes) {
                throw new Error(
                    'File chunk size does not match the source file.'
                );
            }
            hasher.update(bytes);
            uploadChunks.push(new Blob([bytes]));
            nextUploadIndex++;
            send({ type: 'upload_chunk_saved', index: message.index });
            return;
        }
        if (message.type === 'upload_complete') {
            if (!upload || !hasher) {
                throw new Error('File upload has not started.');
            }
            if (nextUploadIndex !== upload.chunkCount) {
                throw new Error('File upload is incomplete.');
            }
            const blob = new Blob(uploadChunks, {
                type: upload.attachment.mediaType,
            });
            if (blob.size !== upload.attachment.sizeBytes) {
                throw new Error(
                    'Transferred file size does not match the source file.'
                );
            }
            const attachment: DraftAttachment = {
                ...upload.attachment,
                hash: bytesToHex(hasher.digest()),
            };
            releaseUploadState();
            await dbStageDraftAttachment(upload.chatId, attachment, blob);
            send({ type: 'upload_saved', hash: attachment.hash });
            if (upload.replicateTo && FILE_PROVIDERS.has(upload.replicateTo)) {
                void replicateDraftAttachment(
                    upload.chatId,
                    upload.replicateTo,
                    attachment,
                    blob,
                    upload.sourceTabId
                );
            }
            return;
        }
        if (message.type === 'download_start') {
            if (upload || downloadBlob) {
                throw new Error('File transfer already started.');
            }
            downloadBlob = await dbGetFileBlob(message.hash);
            if (!downloadBlob) {
                send({ type: 'download_missing' });
                return;
            }
            send({
                type: 'download_ready',
                mediaType: downloadBlob.type,
                sizeBytes: downloadBlob.size,
                chunkCount: Math.ceil(
                    downloadBlob.size / FILE_TRANSFER_CHUNK_BYTES
                ),
            });
            return;
        }
        if (!downloadBlob) {
            throw new Error('File download has not started.');
        }
        const chunkCount = Math.ceil(
            downloadBlob.size / FILE_TRANSFER_CHUNK_BYTES
        );
        if (message.index < 0 || message.index >= chunkCount) {
            throw new Error('Invalid file download chunk.');
        }
        const start = message.index * FILE_TRANSFER_CHUNK_BYTES;
        const bytes = new Uint8Array(
            await downloadBlob
                .slice(start, start + FILE_TRANSFER_CHUNK_BYTES)
                .arrayBuffer()
        );
        send({
            type: 'download_chunk',
            index: message.index,
            base64: bytesToBase64(bytes),
        });
    };

    port.onMessage.addListener((message: FileTransferRequest) => {
        work = work.then(() => handle(message)).catch(fail);
    });
    port.onDisconnect.addListener(() => {
        portOpen = false;
        releaseUploadState();
        releaseStreamPort(port);
    });
}
