export const ASSET_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface AssetRetentionManifest {
    currentAssets: string[];
    lastReferencedAt: Record<string, number>;
}

export function planAssetRetention(
    previous: AssetRetentionManifest | null,
    existingAssets: string[],
    currentAssets: string[],
    now: number
): { manifest: AssetRetentionManifest; expired: string[] } {
    const existing = new Set(existingAssets);
    const current = new Set(currentAssets);
    const lastReferencedAt: Record<string, number> = {};
    for (const key of existing) {
        lastReferencedAt[key] = previous?.lastReferencedAt[key] ?? now;
    }
    for (const key of [...(previous?.currentAssets ?? []), ...current]) {
        if (existing.has(key) || current.has(key)) lastReferencedAt[key] = now;
    }
    const expired = existingAssets.filter(
        (key) =>
            !current.has(key) &&
            lastReferencedAt[key] < now - ASSET_RETENTION_MS
    );
    return { manifest: { currentAssets, lastReferencedAt }, expired };
}

export function parseAssetRetentionManifest(
    raw: unknown
): AssetRetentionManifest {
    if (!raw || typeof raw !== 'object')
        throw new Error('Invalid asset retention manifest.');
    const value = raw as Partial<AssetRetentionManifest>;
    if (
        !Array.isArray(value.currentAssets) ||
        !value.lastReferencedAt ||
        typeof value.lastReferencedAt !== 'object' ||
        Array.isArray(value.lastReferencedAt)
    ) {
        throw new Error('Invalid asset retention manifest.');
    }
    if (
        !value.currentAssets.every(
            (key) => typeof key === 'string' && key.startsWith('assets/')
        ) ||
        !Object.entries(value.lastReferencedAt).every(
            ([key, timestamp]) =>
                key.startsWith('assets/') && Number.isFinite(timestamp)
        )
    ) {
        throw new Error('Invalid asset retention manifest entries.');
    }
    return {
        currentAssets: value.currentAssets,
        lastReferencedAt: value.lastReferencedAt,
    };
}
