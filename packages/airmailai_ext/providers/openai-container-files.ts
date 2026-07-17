import OpenAI from 'openai';
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

const MIME_BY_EXTENSION: Record<string, string> = {
    bmp: 'image/bmp',
    css: 'text/css',
    csv: 'text/csv',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    gif: 'image/gif',
    gz: 'application/gzip',
    htm: 'text/html',
    html: 'text/html',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    js: 'text/javascript',
    json: 'application/json',
    jsonl: 'application/x-ndjson',
    md: 'text/plain',
    mp3: 'audio/mp3',
    mp4: 'video/mp4',
    pdf: 'application/pdf',
    png: 'image/png',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    py: 'text/x-python',
    svg: 'image/svg+xml',
    tar: 'application/x-tar',
    tsv: 'text/tsv',
    txt: 'text/plain',
    wav: 'audio/wav',
    webm: 'video/webm',
    webp: 'image/webp',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xml: 'text/xml',
    zip: 'application/zip',
};

function mimeFromFilename(filename: string): string {
    const dot = filename.lastIndexOf('.');
    if (dot < 0) return 'application/octet-stream';
    return (
        MIME_BY_EXTENSION[filename.slice(dot + 1).toLowerCase()] ??
        'application/octet-stream'
    );
}

export async function listOpenAIContainerFiles(
    apiKey: string,
    containerId: string
): Promise<OpenAIContainerFile[]> {
    const out: OpenAIContainerFile[] = [];
    for await (const f of fileClient(apiKey).containers.files.list(
        containerId
    )) {
        const filename = f.path.split('/').pop() || f.id;
        out.push({
            fileId: f.id,
            filename,
            mediaType: mimeFromFilename(filename),
            source: f.source,
            bytes: f.bytes ?? null,
        });
    }
    return out;
}

export async function downloadOpenAIContainerFile(
    apiKey: string,
    containerId: string,
    fileId: string
): Promise<ArrayBuffer> {
    const resp = await fileClient(apiKey).containers.files.content.retrieve(
        fileId,
        { container_id: containerId }
    );
    return resp.arrayBuffer();
}
