import Anthropic from '@anthropic-ai/sdk';
import type { ProviderFileInfo } from '@airmailai/shared';
import { toReadableAnthropicError } from './anthropic-errors';
import { makeDebugFetch } from './debug-fetch';

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
    filename: string,
    signal?: AbortSignal
): Promise<string> {
    const file = new File([blob], filename, { type: mediaType });
    try {
        const result = await fileClient(apiKey).files.upload(
            { file },
            { signal }
        );
        return result.id;
    } catch (e) {
        throw toReadableAnthropicError(e);
    }
}

export async function deleteAnthropicFile(
    apiKey: string,
    fileId: string
): Promise<void> {
    try {
        await fileClient(apiKey).files.delete(fileId);
    } catch (e) {
        throw toReadableAnthropicError(e);
    }
}

export async function listAnthropicFiles(
    apiKey: string
): Promise<ProviderFileInfo[]> {
    const files: ProviderFileInfo[] = [];
    try {
        for await (const file of fileClient(apiKey).files.list({
            limit: 1000,
        })) {
            files.push({
                fileId: file.id,
                filename: file.filename,
                sizeBytes: file.size_bytes,
                createdAt: new Date(file.created_at).getTime(),
            });
        }
    } catch (e) {
        throw toReadableAnthropicError(e);
    }
    return files;
}
