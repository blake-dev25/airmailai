import { OpenRouter } from '@openrouter/sdk';
import type { ProviderFileInfo } from '@airmailai/shared';
import { isTextMimeType } from '@airmailai/shared';

const OPENROUTER_STORED_IMAGE_TYPES = new Set([
    'image/gif',
    'image/jpeg',
    'image/png',
    'image/webp',
]);

export function openRouterStoresMediaType(mediaType: string): boolean {
    return (
        OPENROUTER_STORED_IMAGE_TYPES.has(mediaType) ||
        mediaType === 'application/pdf' ||
        isTextMimeType(mediaType)
    );
}

function fileClient(apiKey: string): OpenRouter {
    return new OpenRouter({ apiKey });
}

export async function uploadOpenRouterFile(
    apiKey: string,
    blob: Blob,
    filename: string,
    signal?: AbortSignal
): Promise<string> {
    const file = await fileClient(apiKey).files.upload(
        { requestBody: { file: { fileName: filename, content: blob } } },
        signal ? { signal } : undefined
    );
    if (file.shape !== 'openrouter') {
        throw new Error(
            'OpenRouter returned the uploaded file in an unexpected format.'
        );
    }
    return file.id;
}

export async function listOpenRouterFiles(
    apiKey: string
): Promise<ProviderFileInfo[]> {
    const files: ProviderFileInfo[] = [];
    const pages = await fileClient(apiKey).files.list({ limit: 1000 });
    for await (const page of pages) {
        if (page.result.shape !== 'openrouter') {
            throw new Error(
                'OpenRouter returned its file list in an unexpected format.'
            );
        }
        for (const file of page.result.data) {
            files.push({
                fileId: file.id,
                filename: file.filename,
                sizeBytes: file.sizeBytes,
                createdAt: Date.parse(file.createdAt),
            });
        }
    }
    return files;
}

export async function deleteOpenRouterFile(
    apiKey: string,
    fileId: string
): Promise<void> {
    await fileClient(apiKey).files.delete({ fileId });
}
