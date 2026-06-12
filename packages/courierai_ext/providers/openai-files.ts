import OpenAI, { toFile } from 'openai';
import type { ProviderFileInfo } from '@courierai/shared';
import { makeDebugFetch } from './debug-fetch';

function fileClient(apiKey: string): OpenAI {
    return new OpenAI({
        apiKey,
        dangerouslyAllowBrowser: true,
        fetch: makeDebugFetch('openai'),
    });
}

export async function uploadOpenAIFile(
    apiKey: string,
    bytes: Uint8Array,
    mediaType: string,
    filename: string
): Promise<string> {
    const file = await toFile(bytes, filename, { type: mediaType });
    const result = await fileClient(apiKey).files.create({
        file,
        purpose: 'user_data',
    });
    return result.id;
}

export async function listOpenAIFiles(
    apiKey: string
): Promise<ProviderFileInfo[]> {
    const files: ProviderFileInfo[] = [];
    for await (const file of fileClient(apiKey).files.list({ limit: 10000 })) {
        files.push({
            fileId: file.id,
            filename: file.filename,
            mediaType: '',
            sizeBytes: file.bytes,
            createdAt: file.created_at * 1000,
        });
    }
    return files;
}

export async function deleteOpenAIFile(
    apiKey: string,
    fileId: string
): Promise<void> {
    await fileClient(apiKey).files.delete(fileId);
}
