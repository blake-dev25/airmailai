import type { DraftAttachment } from '@courierai/shared';

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

// *** 45MB keeps a staged file's base64 (raw * 4/3 = 60MB) under Chrome's
// 64MiB extension message limit (extensions/renderer/messaging_util.cc).
const GLOBAL_MAX_FILE_BYTES = 45 * MB;

export const FILE_POLICIES: Record<FileProviderId, FilePolicy> = {
    anthropic: {
        providerId: 'anthropic',
        maxAttachments: 100,
        maxFileBytes: 32 * MB,
        maxRequestBytes: 32 * MB,
        mimeTypes: ANTHROPIC_MIME_TYPES,
    },
    google: {
        providerId: 'google',
        maxAttachments: 100,
        maxFileBytes: GLOBAL_MAX_FILE_BYTES,
        maxRequestBytes: 100 * MB,
        mimeTypes: GOOGLE_MIME_TYPES,
        maxAudioAttachments: 1,
        maxVideoAttachments: 10,
    },
    openai: {
        providerId: 'openai',
        maxAttachments: 20,
        maxFileBytes: GLOBAL_MAX_FILE_BYTES,
        maxRequestBytes: 50 * MB,
        mimeTypes: OPENAI_MIME_TYPES,
    },
    openrouter: {
        providerId: 'openrouter',
        maxAttachments: 8,
        maxFileBytes: 32 * MB,
        maxRequestBytes: 32 * MB,
        mimeTypes: EMPTY_MIME_TYPES,
    },
};

const MIME_BY_EXTENSION: Record<string, string> = {
    '.3gp': 'video/3gpp',
    '.3gpp': 'video/3gpp',
    '.aac': 'audio/aac',
    '.aif': 'audio/aiff',
    '.aiff': 'audio/aiff',
    '.asm': 'text/x-asm',
    '.astro': 'text/x-astro',
    '.avi': 'video/avi',
    '.awk': 'text/x-awk',
    '.bat': 'text/x-shellscript',
    '.bmp': 'image/bmp',
    '.c': 'text/x-c',
    '.cc': 'text/x-c++',
    '.clj': 'text/x-clojure',
    '.cmake': 'text/x-cmake',
    '.conf': 'text/plain',
    '.cpp': 'text/x-c++',
    '.cs': 'text/x-csharp',
    '.css': 'text/css',
    '.csv': 'text/csv',
    '.cxx': 'text/x-c++',
    '.dart': 'text/x-dart',
    '.def': 'text/plain',
    '.dic': 'text/plain',
    '.diff': 'text/x-diff',
    '.doc': 'application/msword',
    '.docx':
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.dockerfile': 'text/x-dockerfile',
    '.dot': 'application/msword',
    '.eex': 'text/x-elixir',
    '.ejs': 'text/x-ejs',
    '.el': 'text/x-lisp',
    '.elm': 'text/plain',
    '.eml': 'message/rfc822',
    '.erb': 'text/x-erb',
    '.erl': 'text/x-erlang',
    '.ex': 'text/x-elixir',
    '.exs': 'text/x-elixir',
    '.flac': 'audio/flac',
    '.flv': 'video/x-flv',
    '.gdoc': 'application/vnd.google-apps.document',
    '.gif': 'image/gif',
    '.go': 'text/x-go',
    '.gradle': 'text/x-gradle',
    '.graphql': 'application/graphql',
    '.groovy': 'text/x-groovy',
    '.gsheet': 'application/vnd.google-apps.spreadsheet',
    '.gslides': 'application/vnd.google-apps.presentation',
    '.h': 'text/x-c',
    '.handlebars': 'text/x-handlebars',
    '.hbs': 'text/x-handlebars',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
    '.hh': 'text/x-c++',
    '.hql': 'text/x-hcl',
    '.hs': 'text/x-haskell',
    '.htm': 'text/html',
    '.html': 'text/html',
    '.ics': 'text/calendar',
    '.ifb': 'text/calendar',
    '.iif': 'text/x-iif',
    '.in': 'text/plain',
    '.ini': 'text/x-ini',
    '.jade': 'text/x-jade',
    '.java': 'text/x-java',
    '.jl': 'text/x-julia',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.jsonl': 'application/x-ndjson',
    '.json5': 'application/json5',
    '.jsx': 'text/jsx',
    '.key': 'application/vnd.apple.keynote',
    '.ksh': 'text/x-shellscript',
    '.kt': 'text/x-kotlin',
    '.kts': 'text/x-kotlin',
    '.less': 'text/x-less',
    '.liquid': 'text/x-liquid',
    '.list': 'text/plain',
    '.log': 'text/plain',
    '.lua': 'text/x-lua',
    '.m4a': 'audio/mp3',
    '.markdown': 'text/plain',
    '.md': 'text/plain',
    '.mht': 'message/rfc822',
    '.mhtml': 'message/rfc822',
    '.mime': 'message/rfc822',
    '.mjs': 'text/javascript',
    '.mov': 'video/mov',
    '.mp3': 'audio/mp3',
    '.mp4': 'video/mp4',
    '.mpeg': 'video/mpeg',
    '.mpg': 'video/mpg',
    '.mustache': 'text/x-mustache',
    '.ndjson': 'application/x-ndjson',
    '.nws': 'text/plain',
    '.objectivec': 'text/x-objectivec',
    '.objectivecpp': 'text/x-objectivec++',
    '.odt': 'application/vnd.oasis.opendocument.text',
    '.ogg': 'audio/ogg',
    '.pages': 'application/vnd.apple.pages',
    '.patch': 'text/x-patch',
    '.pdf': 'application/pdf',
    '.php': 'text/x-php',
    '.pl': 'text/x-perl',
    '.png': 'image/png',
    '.pot': 'application/vnd.ms-powerpoint',
    '.ppa': 'application/vnd.ms-powerpoint',
    '.pps': 'application/vnd.ms-powerpoint',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx':
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.properties': 'text/x-properties',
    '.proto': 'text/x-protobuf',
    '.pug': 'text/x-pug',
    '.pwsh': 'application/x-powershell',
    '.pwz': 'application/vnd.ms-powerpoint',
    '.py': 'text/x-python',
    '.r': 'text/x-r',
    '.rb': 'text/x-ruby',
    '.rst': 'text/x-rst',
    '.rtf': 'text/rtf',
    '.rs': 'text/x-rust',
    '.s': 'text/x-asm',
    '.sass': 'text/x-sass',
    '.scala': 'text/x-scala',
    '.scss': 'text/x-scss',
    '.sh': 'text/x-sh',
    '.sql': 'text/x-sql',
    '.srt': 'text/srt',
    '.swift': 'text/x-swift',
    '.text': 'text/plain',
    '.tf': 'text/x-terraform',
    '.tiff': 'image/tiff',
    '.tmpl': 'text/x-tmpl',
    '.toml': 'text/x-toml',
    '.ts': 'text/x-typescript',
    '.tsx': 'text/tsx',
    '.tsv': 'text/tsv',
    '.twig': 'text/x-twig',
    '.txt': 'text/plain',
    '.vb': 'text/vbscript',
    '.vcf': 'text/x-vcard',
    '.vtt': 'text/vtt',
    '.wav': 'audio/wav',
    '.webm': 'video/webm',
    '.webp': 'image/webp',
    '.wiz': 'application/vnd.ms-powerpoint',
    '.wmv': 'video/wmv',
    '.xla': 'application/vnd.ms-excel',
    '.xlb': 'application/vnd.ms-excel',
    '.xlc': 'application/vnd.ms-excel',
    '.xlm': 'application/vnd.ms-excel',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xlt': 'application/vnd.ms-excel',
    '.xlw': 'application/vnd.ms-excel',
    '.xml': 'text/xml',
    '.yaml': 'text/x-yaml',
    '.yml': 'text/x-yaml',
    '.zsh': 'text/x-zsh',
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

export function getMimeTypeFromFilename(filename: string): string | null {
    const ext = getExtensionFromFilename(filename);
    return ext ? (MIME_BY_EXTENSION[ext] ?? null) : null;
}

function getExtensionFromFilename(filename: string): string | null {
    const dot = filename.lastIndexOf('.');
    if (dot < 0) return null;
    return filename.slice(dot).toLowerCase();
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

export async function hashBytes(bytes: ArrayBuffer): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const view = new Uint8Array(digest);
    let hex = '';
    for (let i = 0; i < view.length; i++) {
        hex += view[i].toString(16).padStart(2, '0');
    }
    return hex;
}

export function triggerBlobDownload(
    filename: string,
    mediaType: string,
    base64: string
): void {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: mediaType }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

export function openBlobInNewTab(
    mediaType: string,
    base64: string,
    page?: number
): void {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: mediaType }));
    window.open(page ? `${url}#page=${page}` : url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
    const mb = kb / 1024;
    return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
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
    attachments: DraftAttachment[],
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
        if (attachment.encodedSizeBytes > policy.maxFileBytes) {
            return {
                ok: false,
                message: `${attachment.name} is too large after encoding. Limit: ${formatFileSize(policy.maxFileBytes)}.`,
            };
        }
        if (attachment.mediaType.startsWith('audio/')) audioCount++;
        if (attachment.mediaType.startsWith('video/')) videoCount++;
        total += attachment.encodedSizeBytes;
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
