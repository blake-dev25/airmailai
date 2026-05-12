import type { Attachment } from '@courier/shared';

const MB = 1024 * 1024;

export type FileProviderId = 'anthropic' | 'google' | 'openai' | 'openrouter';

export interface FilePolicy {
    providerId: FileProviderId;
    maxFileBytes: number;
    maxRequestBytes: number;
    mimeTypes: ReadonlySet<string>;
}

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

export const FILE_POLICIES: Record<FileProviderId, FilePolicy> = {
    anthropic: {
        providerId: 'anthropic',
        maxFileBytes: 32 * MB,
        maxRequestBytes: 32 * MB,
        mimeTypes: ANTHROPIC_MIME_TYPES,
    },
    google: {
        providerId: 'google',
        maxFileBytes: 50 * MB,
        maxRequestBytes: 100 * MB,
        mimeTypes: GOOGLE_MIME_TYPES,
    },
    openai: {
        providerId: 'openai',
        maxFileBytes: 50 * MB,
        maxRequestBytes: 50 * MB,
        mimeTypes: OPENAI_MIME_TYPES,
    },
    openrouter: {
        providerId: 'openrouter',
        maxFileBytes: 50 * MB,
        maxRequestBytes: 50 * MB,
        mimeTypes: OPENAI_MIME_TYPES,
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
    '.mov': 'video/quicktime',
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

export function getFilePolicy(providerId: string): FilePolicy {
    return FILE_POLICIES[toProviderId(providerId)];
}

export function getMimeTypeFromFilename(filename: string): string | null {
    const dot = filename.lastIndexOf('.');
    if (dot < 0) return null;
    const ext = filename.slice(dot).toLowerCase();
    return MIME_BY_EXTENSION[ext] ?? null;
}

export function getAcceptForProvider(providerId: string): string {
    const id = toProviderId(providerId);
    const cached = ACCEPT_BY_PROVIDER.get(id);
    if (cached) return cached;

    const policy = getFilePolicy(id);
    const extensions = Object.entries(MIME_BY_EXTENSION)
        .filter(([, mimeType]) => policy.mimeTypes.has(mimeType))
        .map(([extension]) => extension)
        .sort();
    const accept = extensions.join(',');
    ACCEPT_BY_PROVIDER.set(id, accept);
    return accept;
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

export function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
    const mb = kb / 1024;
    return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

export function validateReadyAttachments(
    attachments: Attachment[],
    providerId: string
): { ok: true } | { ok: false; message: string } {
    const policy = getFilePolicy(providerId);
    let total = 0;

    for (const attachment of attachments) {
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
        total += attachment.encodedSizeBytes;
    }

    if (total > policy.maxRequestBytes) {
        return {
            ok: false,
            message: `Attached files are too large together. Limit: ${formatFileSize(policy.maxRequestBytes)}.`,
        };
    }

    return { ok: true };
}
