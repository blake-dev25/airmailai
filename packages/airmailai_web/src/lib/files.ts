import type { DraftAttachmentMeta } from '@airmailai/shared';
import { getMimeTypeFromFilename } from '@airmailai/shared';

const MB = 1024 * 1024;

export type FileProviderId = 'anthropic' | 'google' | 'openai' | 'openrouter';

export interface FilePolicy {
    providerId: FileProviderId;
    maxAttachments: number;
    maxFileBytes: number;
    maxRequestBytes: number;
    mimeTypes: ReadonlySet<string>;
    maxAudioAttachments?: number;
    maxVideoAttachments?: number;
}

export interface FilePolicyModel {
    inputModalities?: readonly string[];
}

const EMPTY_MIME_TYPES = new Set<string>();

const OPENAI_MIME_TYPES = new Set([
    'application/csv',
    'application/graphql',
    'application/javascript',
    'application/json',
    'application/json5',
    'application/msword',
    'application/pdf',
    'application/rtf',
    'application/toml',
    'application/typescript',
    'application/vnd.apple.iwork',
    'application/vnd.apple.keynote',
    'application/vnd.apple.pages',
    'application/vnd.google-apps.document',
    'application/vnd.google-apps.presentation',
    'application/vnd.google-apps.spreadsheet',
    'application/vnd.ms-excel',
    'application/vnd.ms-powerpoint',
    'application/vnd.oasis.opendocument.text',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/x-awk',
    'application/x-bash',
    'application/x-graphql',
    'application/x-httpd-php',
    'application/x-httpd-php-source',
    'application/x-iif',
    'application/x-json5',
    'application/x-ndjson',
    'application/x-patch',
    'application/x-php',
    'application/x-protobuf',
    'application/x-powershell',
    'application/x-sql',
    'application/x-subrip',
    'application/x-terraform',
    'application/x-toml',
    'application/x-yaml',
    'application/yaml',
    'image/gif',
    'image/jpeg',
    'image/png',
    'image/webp',
    'message/rfc822',
    'text/calendar',
    'text/css',
    'text/csv',
    'text/html',
    'text/javascript',
    'text/jsx',
    'text/markdown',
    'text/plain',
    'text/rtf',
    'text/srt',
    'text/tsx',
    'text/tsv',
    'text/vbscript',
    'text/vtt',
    'text/x-R',
    'text/x-asm',
    'text/x-astro',
    'text/x-awk',
    'text/x-bash',
    'text/x-c',
    'text/x-c++',
    'text/x-clojure',
    'text/x-cmake',
    'text/x-csharp',
    'text/x-dart',
    'text/x-diff',
    'text/x-dockerfile',
    'text/x-ejs',
    'text/x-elixir',
    'text/x-erb',
    'text/x-erlang',
    'text/x-go',
    'text/x-golang',
    'text/x-gradle',
    'text/x-graphql',
    'text/x-groovy',
    'text/x-handlebars',
    'text/x-haskell',
    'text/x-hcl',
    'text/x-iif',
    'text/x-ini',
    'text/x-jade',
    'text/x-java',
    'text/x-jinja2',
    'text/x-julia',
    'text/x-kotlin',
    'text/x-less',
    'text/x-liquid',
    'text/x-lisp',
    'text/x-lua',
    'text/x-makefile',
    'text/x-mustache',
    'text/x-objectivec',
    'text/x-objectivec++',
    'text/x-patch',
    'text/x-perl',
    'text/x-php',
    'text/x-properties',
    'text/x-protobuf',
    'text/x-pug',
    'text/x-python',
    'text/x-r',
    'text/x-rst',
    'text/x-ruby',
    'text/x-rust',
    'text/x-sass',
    'text/x-scala',
    'text/x-scss',
    'text/x-script.python',
    'text/x-sh',
    'text/x-shellscript',
    'text/x-sql',
    'text/x-subrip',
    'text/x-swift',
    'text/x-terraform',
    'text/x-tex',
    'text/x-tmpl',
    'text/x-toml',
    'text/x-twig',
    'text/x-typescript',
    'text/x-vcard',
    'text/x-xml',
    'text/x-yaml',
    'text/x-zsh',
    'text/xml',
]);

const ANTHROPIC_MIME_TYPES = new Set([
    'application/pdf',
    'image/gif',
    'image/jpeg',
    'image/png',
    'image/webp',
    'text/plain',
]);

const GOOGLE_MIME_TYPES = new Set([
    'application/pdf',
    'audio/aac',
    'audio/aiff',
    'audio/flac',
    'audio/mp3',
    'audio/ogg',
    'audio/wav',
    'image/heic',
    'image/heif',
    'image/jpeg',
    'image/png',
    'image/webp',
    'text/css',
    'text/csv',
    'text/html',
    'text/javascript',
    'text/plain',
    'text/rtf',
    'text/xml',
    'video/3gpp',
    'video/avi',
    'video/mov',
    'video/mp4',
    'video/mpeg',
    'video/mpg',
    'video/quicktime',
    'video/webm',
    'video/wmv',
    'video/x-flv',
]);

const OPENROUTER_MIME_TYPES_BY_MODALITY: Record<string, readonly string[]> = {
    image: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    file: ['application/pdf', 'text/plain'],
    audio: ['audio/wav', 'audio/mp3'],
    video: ['video/mp4', 'video/mpeg', 'video/mov', 'video/webm'],
};

const ACCEPT_EXTENSIONS_BY_PROVIDER: Record<
    Exclude<FileProviderId, 'openrouter'>,
    readonly string[]
> = {
    anthropic: [
        '.gif',
        '.jpeg',
        '.jpg',
        '.md',
        '.pdf',
        '.png',
        '.txt',
        '.webp',
    ],
    google: [
        '.3gp',
        '.3gpp',
        '.aac',
        '.aif',
        '.aiff',
        '.avi',
        '.css',
        '.csv',
        '.flac',
        '.flv',
        '.heic',
        '.heif',
        '.htm',
        '.html',
        '.jpeg',
        '.jpg',
        '.js',
        '.md',
        '.mov',
        '.mp3',
        '.mp4',
        '.mpeg',
        '.mpg',
        '.ogg',
        '.pdf',
        '.png',
        '.rtf',
        '.txt',
        '.wav',
        '.webm',
        '.webp',
        '.wmv',
        '.xml',
    ],
    openai: [
        '.c',
        '.cpp',
        '.cs',
        '.css',
        '.csv',
        '.doc',
        '.docx',
        '.gif',
        '.go',
        '.html',
        '.java',
        '.jpeg',
        '.jpg',
        '.js',
        '.json',
        '.jsonl',
        '.md',
        '.pdf',
        '.php',
        '.png',
        '.ppt',
        '.pptx',
        '.py',
        '.rb',
        '.rtf',
        '.sh',
        '.tex',
        '.ts',
        '.txt',
        '.webp',
        '.xls',
        '.xlsx',
        '.xml',
    ],
};

const OPENROUTER_ACCEPT_EXTENSIONS_BY_MODALITY: Record<
    string,
    readonly string[]
> = {
    audio: ['.mp3', '.wav'],
    file: ['.md', '.pdf', '.txt'],
    image: ['.gif', '.jpeg', '.jpg', '.png', '.webp'],
    video: ['.mov', '.mp4', '.mpeg', '.webm'],
};

export const FILE_POLICIES: Record<FileProviderId, FilePolicy> = {
    anthropic: {
        providerId: 'anthropic',
        maxAttachments: 100,
        maxFileBytes: 500 * MB,
        maxRequestBytes: 500 * MB,
        mimeTypes: ANTHROPIC_MIME_TYPES,
    },
    google: {
        providerId: 'google',
        maxAttachments: 100,
        maxFileBytes: 2 * 1024 * MB,
        maxRequestBytes: 2 * 1024 * MB,
        mimeTypes: GOOGLE_MIME_TYPES,
        maxAudioAttachments: 1,
        maxVideoAttachments: 10,
    },
    openai: {
        providerId: 'openai',
        maxAttachments: 20,
        maxFileBytes: 512 * MB,
        maxRequestBytes: 512 * MB,
        mimeTypes: OPENAI_MIME_TYPES,
    },
    openrouter: {
        providerId: 'openrouter',
        maxAttachments: 8,
        maxFileBytes: 8 * MB,
        maxRequestBytes: 8 * MB,
        mimeTypes: EMPTY_MIME_TYPES,
    },
};

const ACCEPT_BY_PROVIDER = new Map<FileProviderId, string>();

function toProviderId(providerId: string): FileProviderId {
    return providerId in FILE_POLICIES
        ? (providerId as FileProviderId)
        : 'anthropic';
}

export interface FilePolicyOptions {
    openRouterPdfEngine?: string;
}

function getOpenRouterMimeTypes(
    model: FilePolicyModel | null | undefined,
    pdfEngine: string | undefined
): Set<string> {
    const mimeTypes = new Set<string>(['text/plain']);
    for (const modality of model?.inputModalities ?? []) {
        const supported = OPENROUTER_MIME_TYPES_BY_MODALITY[modality];
        if (!supported) continue;
        for (const mimeType of supported) mimeTypes.add(mimeType);
    }
    if (pdfEngine && pdfEngine !== 'native') {
        mimeTypes.add('application/pdf');
    }
    return mimeTypes;
}

export function getFilePolicy(
    providerId: string,
    model?: FilePolicyModel | null,
    opts: FilePolicyOptions = {}
): FilePolicy {
    const id = toProviderId(providerId);
    return id !== 'openrouter'
        ? FILE_POLICIES[id]
        : {
              ...FILE_POLICIES.openrouter,
              mimeTypes: getOpenRouterMimeTypes(
                  model,
                  opts.openRouterPdfEngine
              ),
          };
}

function getAcceptForOpenRouterModel(
    model: FilePolicyModel | null | undefined,
    pdfEngine: string | undefined
): readonly string[] {
    const extensions = new Set<string>(['.md', '.txt']);
    for (const modality of model?.inputModalities ?? []) {
        const supported = OPENROUTER_ACCEPT_EXTENSIONS_BY_MODALITY[modality];
        if (!supported) continue;
        for (const extension of supported) extensions.add(extension);
    }
    if (pdfEngine && pdfEngine !== 'native') {
        extensions.add('.pdf');
    }
    return Array.from(extensions);
}

function toAcceptString(extensions: readonly string[]): string {
    return Array.from(new Set(extensions)).sort().join(',');
}

export function getAcceptForProvider(
    providerId: string,
    model?: FilePolicyModel | null,
    opts: FilePolicyOptions = {}
): string {
    const id = toProviderId(providerId);
    if (id === 'openrouter') {
        return toAcceptString(
            getAcceptForOpenRouterModel(model, opts.openRouterPdfEngine)
        );
    }

    const cached = ACCEPT_BY_PROVIDER.get(id);
    if (cached) return cached;

    const accept = toAcceptString(ACCEPT_EXTENSIONS_BY_PROVIDER[id]);
    ACCEPT_BY_PROVIDER.set(id, accept);
    return accept;
}

function normalizeBrowserMimeType(mimeType: string): string | null {
    const normalized = mimeType.split(';', 1)[0]?.trim().toLowerCase();
    return normalized || null;
}

export function resolveFileMediaType(
    file: Pick<File, 'name' | 'type'>,
    providerId: string,
    model?: FilePolicyModel | null,
    opts: FilePolicyOptions = {}
): string | null {
    const policy = getFilePolicy(providerId, model, opts);
    const extensionMimeType = getMimeTypeFromFilename(file.name);
    if (extensionMimeType && policy.mimeTypes.has(extensionMimeType)) {
        return extensionMimeType;
    }

    const browserMimeType = normalizeBrowserMimeType(file.type);
    if (browserMimeType && policy.mimeTypes.has(browserMimeType)) {
        return browserMimeType;
    }

    return null;
}

export function triggerBlobDownload(filename: string, blob: Blob): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

const VIEWABLE_MEDIA_TYPES = new Set([
    'application/pdf',
    'text/plain',
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
]);

export function openBlobInNewTab(blob: Blob, page?: number): void {
    if (!VIEWABLE_MEDIA_TYPES.has(blob.type)) {
        throw new Error(
            `Refusing to open ${blob.type || 'a file of unknown type'} in a new tab.`
        );
    }
    const url = URL.createObjectURL(blob);
    window.open(page ? `${url}#page=${page}` : url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
    const gb = mb / 1024;
    return `${gb.toFixed(gb < 10 ? 1 : 0)} GB`;
}

const FORBIDDEN_FILENAME_CHARS = '<>:"|?*\\/';

export function validateFilename(
    name: string
): { ok: true } | { ok: false; message: string } {
    if (name.length < 1 || name.length > 255) {
        return { ok: false, message: 'File names must be 1-255 characters.' };
    }
    for (let i = 0; i < name.length; i++) {
        if (
            name.charCodeAt(i) < 32 ||
            FORBIDDEN_FILENAME_CHARS.includes(name.charAt(i))
        ) {
            return {
                ok: false,
                message: `${name} contains characters that aren't allowed in a file name (< > : " | ? * \\ / or control characters).`,
            };
        }
    }
    return { ok: true };
}

export function validateReadyAttachments(
    attachments: DraftAttachmentMeta[],
    providerId: string,
    model?: FilePolicyModel | null,
    opts: FilePolicyOptions = {}
): { ok: true } | { ok: false; message: string } {
    const policy = getFilePolicy(providerId, model, opts);
    if (attachments.length > policy.maxAttachments) {
        return {
            ok: false,
            message: `Only ${policy.maxAttachments} files can be attached for this provider.`,
        };
    }

    let total = 0;
    let audioCount = 0;
    let videoCount = 0;

    for (const attachment of attachments) {
        const nameCheck = validateFilename(attachment.name);
        if (!nameCheck.ok) return nameCheck;
        if (!policy.mimeTypes.has(attachment.mediaType)) {
            return {
                ok: false,
                message: `${attachment.name} is not supported by this provider.`,
            };
        }
        if (attachment.sizeBytes > policy.maxFileBytes) {
            return {
                ok: false,
                message: `${attachment.name} is too large. Limit: ${formatFileSize(policy.maxFileBytes)}.`,
            };
        }
        if (attachment.mediaType.startsWith('audio/')) audioCount++;
        if (attachment.mediaType.startsWith('video/')) videoCount++;
        total += attachment.sizeBytes;
    }

    if (
        policy.maxAudioAttachments !== undefined &&
        audioCount > policy.maxAudioAttachments
    ) {
        return {
            ok: false,
            message: `Only ${policy.maxAudioAttachments} audio file can be attached for this provider.`,
        };
    }

    if (
        policy.maxVideoAttachments !== undefined &&
        videoCount > policy.maxVideoAttachments
    ) {
        return {
            ok: false,
            message: `Only ${policy.maxVideoAttachments} video files can be attached for this provider.`,
        };
    }

    if (total > policy.maxRequestBytes) {
        return {
            ok: false,
            message: `Attached files are too large together. Limit: ${formatFileSize(policy.maxRequestBytes)}.`,
        };
    }

    return { ok: true };
}
