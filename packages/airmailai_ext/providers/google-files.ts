import { FileState, GoogleGenAI, type File as GoogleFile } from '@google/genai';
import type { ProviderFileEntry, ProviderFileInfo } from '@airmailai/shared';

const PROCESSING_POLL_MS = 1000;
const PROCESSING_MAX_POLLS = 60;

function fileClient(apiKey: string): GoogleGenAI {
    return new GoogleGenAI({ apiKey });
}

function toEntry(file: GoogleFile): ProviderFileEntry {
    if (!file.name) {
        throw new Error('Google file upload returned no file name.');
    }
    return {
        fileId: file.name,
        ...(file.uri ? { uri: file.uri } : {}),
        ...(file.expirationTime
            ? { expiresAt: new Date(file.expirationTime).getTime() }
            : {}),
    };
}

export async function uploadGoogleFile(
    apiKey: string,
    bytes: Uint8Array<ArrayBuffer>,
    mediaType: string,
    filename: string
): Promise<ProviderFileEntry> {
    const client = fileClient(apiKey);
    let file = await client.files.upload({
        file: new Blob([bytes], { type: mediaType }),
        config: { mimeType: mediaType, displayName: filename },
    });
    let polls = 0;
    while (file.state === FileState.PROCESSING && file.name) {
        if (++polls > PROCESSING_MAX_POLLS) {
            throw new Error(
                `Google is still processing ${filename} after ${PROCESSING_MAX_POLLS}s. Try again shortly.`
            );
        }
        await new Promise((r) => setTimeout(r, PROCESSING_POLL_MS));
        file = await client.files.get({ name: file.name });
    }
    if (file.state === FileState.FAILED) {
        throw new Error(`Google failed to process ${filename}.`);
    }
    return toEntry(file);
}

export async function listGoogleFiles(
    apiKey: string
): Promise<ProviderFileInfo[]> {
    const files: ProviderFileInfo[] = [];
    for await (const file of await fileClient(apiKey).files.list()) {
        if (!file.name) continue;
        files.push({
            fileId: file.name,
            filename: file.displayName ?? file.name,
            mediaType: file.mimeType ?? '',
            sizeBytes: file.sizeBytes ? Number(file.sizeBytes) : 0,
            createdAt: file.createTime
                ? new Date(file.createTime).getTime()
                : 0,
        });
    }
    return files;
}

export async function deleteGoogleFile(
    apiKey: string,
    fileId: string
): Promise<void> {
    await fileClient(apiKey).files.delete({ name: fileId });
}
