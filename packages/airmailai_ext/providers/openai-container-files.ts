import OpenAI from 'openai';
import { getMimeTypeFromFilename } from '@airmailai/shared';
import { makeDebugFetch } from './debug-fetch';

function fileClient(apiKey: string): OpenAI {
    return new OpenAI({
        apiKey,
        dangerouslyAllowBrowser: true,
        fetch: makeDebugFetch('openai'),
    });
}

export interface OpenAIContainerFile {
    fileId: string;
    filename: string;
    mediaType: string;
    source: string;
    bytes: number | null;
}

export async function listOpenAIContainerFiles(
    apiKey: string,
    containerId: string,
    signal?: AbortSignal
): Promise<OpenAIContainerFile[]> {
    const out: OpenAIContainerFile[] = [];
    for await (const f of fileClient(apiKey).containers.files.list(
        containerId,
        undefined,
        { signal }
    )) {
        const filename = f.path.split('/').pop() || f.id;
        out.push({
            fileId: f.id,
            filename,
            mediaType:
                getMimeTypeFromFilename(filename) ?? 'application/octet-stream',
            source: f.source,
            bytes: f.bytes ?? null,
        });
    }
    return out;
}

export async function downloadOpenAIContainerFile(
    apiKey: string,
    containerId: string,
    fileId: string,
    signal?: AbortSignal
): Promise<ArrayBuffer> {
    const resp = await fileClient(apiKey).containers.files.content.retrieve(
        fileId,
        { container_id: containerId },
        { signal }
    );
    return resp.arrayBuffer();
}
