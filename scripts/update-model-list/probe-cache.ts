import { resolve } from 'node:path';
import { type ModelProbeResult, SNAPSHOT_DIR } from './shared';

export const PROBE_CACHE_PATH = resolve(SNAPSHOT_DIR, 'probe-cache.json');
export const NON_200_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

type CacheProvider = 'anthropic' | 'openai' | 'google';
const CACHE_PROVIDERS: CacheProvider[] = ['anthropic', 'openai', 'google'];

interface StoredProbe extends ModelProbeResult {
    probedAt: number;
}

type CacheSections = Record<CacheProvider, Record<string, StoredProbe>>;

interface ProbeCacheOptions {
    refresh: boolean;
    retryNon200: boolean;
}

export interface ProbeCacheSection {
    get(key: string): ModelProbeResult | undefined;
    set(key: string, result: ModelProbeResult): void;
}

export function non200Expired(cachedAt: number, now: number): boolean {
    return now - cachedAt > NON_200_CACHE_TTL_MS;
}

export class ProbeCache {
    private constructor(
        private readonly sections: CacheSections,
        private readonly options: ProbeCacheOptions
    ) {}

    static async load(options: ProbeCacheOptions): Promise<ProbeCache> {
        const sections: CacheSections = {
            anthropic: {},
            openai: {},
            google: {},
        };
        const file = Bun.file(PROBE_CACHE_PATH);
        if (!(await file.exists())) {
            console.log(
                `no probe cache at ${PROBE_CACHE_PATH} - probing everything`
            );
            return new ProbeCache(sections, options);
        }
        const parsed = JSON.parse(await file.text()) as Partial<CacheSections>;
        let entries = 0;
        for (const provider of CACHE_PROVIDERS) {
            const section = parsed[provider];
            if (!section || typeof section !== 'object') continue;
            entries += Object.keys(section).length;
            sections[provider] = section;
        }
        console.log(
            options.refresh
                ? `ignoring probe cache (${entries} entries) due to --refresh-probes`
                : `loaded probe cache (${entries} entries) from ${PROBE_CACHE_PATH}`
        );
        return new ProbeCache(sections, options);
    }

    section(provider: CacheProvider): ProbeCacheSection {
        const store = this.sections[provider];
        return {
            get: (key) => {
                if (this.options.refresh) return undefined;
                const stored = store[key];
                if (!stored) return undefined;
                if (
                    stored.code !== '200' &&
                    (this.options.retryNon200 ||
                        non200Expired(stored.probedAt, Date.now()))
                ) {
                    return undefined;
                }
                return { status: stored.status, code: stored.code };
            },
            set: (key, result) => {
                store[key] = { ...result, probedAt: Date.now() };
            },
        };
    }

    async save(): Promise<void> {
        await Bun.write(
            PROBE_CACHE_PATH,
            JSON.stringify(this.sections, null, 2)
        );
    }
}

export function splitCachedProbes<T>(
    items: T[],
    section: ProbeCacheSection,
    keyOf: (item: T) => string
): {
    hits: Array<{ item: T; probe: ModelProbeResult }>;
    misses: T[];
} {
    const hits: Array<{ item: T; probe: ModelProbeResult }> = [];
    const misses: T[] = [];
    for (const item of items) {
        const probe = section.get(keyOf(item));
        if (probe) hits.push({ item, probe });
        else misses.push(item);
    }
    return { hits, misses };
}
