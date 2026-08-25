import Anthropic from '@anthropic-ai/sdk';
import type { ProviderFileInfo } from '@airmailai/shared';
import { makeDebugFetch } from './debug-fetch';

export const FILES_BETA = 'files-api-2025-04-14';

function fileClient(apiKey: string): Anthropic {
    return new Anthropic({
        apiKey,
        dangerouslyAllowBrowser: true,
        fetch: makeDebugFetch('anthropic'),
    });
}

export async function uploadAnthropicFile(
    apiKey: string,
    blob: Blob,
    mediaType: string,
    filename: string
): Promise<string> {
    const file = new File([blob], filename, { type: mediaType });
    const result = await fileClient(apiKey).beta.files.upload({
        file,
        betas: [FILES_BETA],
    });
    return result.id;
}

export async function deleteAnthropicFile(
    apiKey: string,
    fileId: string
): Promise<void> {
    await fileClient(apiKey).beta.files.delete(fileId, { betas: [FILES_BETA] });
}

export async function listAnthropicFiles(
    apiKey: string
): Promise<ProviderFileInfo[]> {
    const files: ProviderFileInfo[] = [];
    for await (const file of fileClient(apiKey).beta.files.list({
        betas: [FILES_BETA],
        limit: 1000,
    })) {
        files.push({
            fileId: file.id,
            filename: file.filename,
            mediaType: file.mime_type,
            sizeBytes: file.size_bytes,
            createdAt: new Date(file.created_at).getTime(),
        });
    }
    return files;
}
