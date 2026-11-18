import type { AirmailAIMessage, ProviderId } from '@airmailai/shared';
import { errorMessage } from '@airmailai/shared';
import { log } from '../debug';
import { anthropicSupportsInlineFile } from '../providers/anthropic';
import {
    downloadOpenAIContainerFile,
    listOpenAIContainerFiles,
} from '../providers/openai-container-files';
import { dbGetMeta } from '../storage/db';
import { hashBytes } from '../storage/encoding';
import { fileTooLargeForProvider, uploadWithDedup } from './provider-file-sync';

interface OpenAICaptureResult {
    parts: AirmailAIMessage['parts'];
    freshBlobs: Map<string, Blob>;
    containerFileIds: string[];
    warning?: string;
}

export async function captureOpenAIOutputs(
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
    const freshBlobs = new Map<string, Blob>();
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
        const blob = new Blob([bytes], { type: f.mediaType });
        freshBlobs.set(hash, blob);
        capturedParts.push({
            type: 'file',
            filename: f.filename,
            mediaType: f.mediaType,
            sizeBytes: bytes.byteLength,
            hash,
        });
        containerFileIds.push(f.fileId);
        if (!storageOn) continue;
        if (fileTooLargeForProvider('openai', bytes.byteLength, storageOn)) {
            log.info(
                'skipping provider replica, file exceeds provider limit',
                f.filename,
                bytes.byteLength
            );
            continue;
        }
        try {
            await uploadWithDedup(
                hash,
                'openai',
                apiKey,
                blob,
                f.mediaType,
                f.filename,
                signal
            );
        } catch (err) {
            if (signal.aborted) break;
            log.error('output replica upload failed', err);
            warnings.push(`${f.filename}: ${errorMessage(err)}`);
        }
    }
    return {
        parts: capturedParts,
        freshBlobs,
        containerFileIds,
        ...(warnings.length ? { warning: warnings.join('; ') } : {}),
    };
}

export function replayAssistantFiles(
    messages: AirmailAIMessage[],
    provider: ProviderId,
    storageOn: boolean,
    codeExecution: boolean
): AirmailAIMessage[] {
    if (
        provider === 'google' ||
        (storageOn &&
            (provider === 'anthropic' ||
                (provider === 'openai' && codeExecution)))
    )
        return messages;
    return messages.map((message) =>
        message.role !== 'assistant'
            ? message
            : {
                  ...message,
                  parts: message.parts.filter(
                      (part) =>
                          part.type !== 'file' ||
                          (provider === 'anthropic' &&
                              anthropicSupportsInlineFile(part.mediaType))
                  ),
              }
    );
}
