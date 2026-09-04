import { bytesToHex } from '@noble/hashes/utils.js';

export function bytesToBase64(bytes: Uint8Array): string {
    return bytes.toBase64();
}

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
    return Uint8Array.fromBase64(base64);
}

export function decodeBase64Text(base64: string): string {
    return new TextDecoder().decode(base64ToBytes(base64));
}

export async function hashBytes(bytes: ArrayBuffer): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return bytesToHex(new Uint8Array(digest));
}
