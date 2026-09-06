export const EXTENSION_ID = 'mpffonlfgjkbmgdnbpghihbgkmgnfhlo';

export interface ExtensionProbeRequest {
    type: 'get_extension_info';
}

export interface ExtensionProbeResponse {
    type: 'extension_info';
    version: string;
    versionName: string | null;
}
