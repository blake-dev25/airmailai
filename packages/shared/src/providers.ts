export const PROVIDER_IDS = [
    'anthropic',
    'google',
    'openai',
    'openrouter',
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(value: unknown): value is ProviderId {
    return PROVIDER_IDS.some((id) => id === value);
}

export const ANTHROPIC_API_VERSION = '2026-10-21';

const MB = 1024 * 1024;

export const PROVIDER_STORED_MAX_FILE_BYTES: Record<ProviderId, number> = {
    anthropic: 500 * MB,
    google: 2048 * MB,
    openai: 512 * MB,
    openrouter: 8 * MB,
};

export const PROVIDER_INLINE_MAX_REQUEST_BYTES: Record<ProviderId, number> = {
    anthropic: 25 * MB,
    google: 25 * MB,
    openai: 25 * MB,
    openrouter: 8 * MB,
};

export function providerMaxFileBytes(
    provider: ProviderId,
    providerFileStorage: boolean
): number {
    return providerFileStorage
        ? PROVIDER_STORED_MAX_FILE_BYTES[provider]
        : PROVIDER_INLINE_MAX_REQUEST_BYTES[provider];
}
