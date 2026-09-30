import type { ModelProbeResult, ModelProbeStatus, Provider } from './shared';
import type { StateStore } from './state-store';

export const PROBE_CACHE_KEY = 'probe-cache.json';
export const NON_200_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const PROBE_STATUSES: ModelProbeStatus[] = ['ok', 'grandfathered', 'dead'];
const CACHE_PROVIDERS: Provider[] = ['anthropic', 'openai', 'google'];

interface StoredProbe extends ModelProbeResult {
    probedAt: number;
}

type CacheSections = Record<Provider, Record<string, StoredProbe>>;

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
        private readonly store: StateStore,
        private readonly sections: CacheSections,
        private readonly options: ProbeCacheOptions
    ) {}

    static async load(
        store: StateStore,
        options: ProbeCacheOptions
    ): Promise<ProbeCache> {
        const sections: CacheSections = {
            anthropic: {},
            openai: {},
            google: {},
        };
        const location = store.describe(PROBE_CACHE_KEY);
        const text = await store.read(PROBE_CACHE_KEY);
        if (text === null) {
            console.log(`no probe cache at ${location} - probing everything`);
            return new ProbeCache(store, sections, options);
        }
        const parsed = JSON.parse(text) as Partial<
            Record<Provider, Record<string, unknown>>
        >;
        let entries = 0;
        const malformed: string[] = [];
        for (const provider of CACHE_PROVIDERS) {
            const section = parsed[provider];
            if (!section || typeof section !== 'object') continue;
            for (const [key, value] of Object.entries(section)) {
                if (isStoredProbe(value)) sections[provider][key] = value;
                else malformed.push(`${provider}/${key}`);
            }
            entries += Object.keys(section).length;
        }
        if (malformed.length > 0) {
            throw new Error(
                `${malformed.length} malformed probe cache entry/entries in ${location} - delete them to re-probe:\n${malformed.map((k) => `   - ${k}`).join('\n')}`
            );
        }
        console.log(
            options.refresh
                ? `ignoring probe cache (${entries} entries) due to --refresh-probes`
                : `loaded probe cache (${entries} entries) from ${location}`
        );
        return new ProbeCache(store, sections, options);
    }

    section(provider: Provider): ProbeCacheSection {
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
        await this.store.write(
            PROBE_CACHE_KEY,
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

function isStoredProbe(value: unknown): value is StoredProbe {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<StoredProbe>;
    return (
        candidate.status !== undefined &&
        PROBE_STATUSES.includes(candidate.status) &&
        typeof candidate.code === 'string' &&
        typeof candidate.probedAt === 'number'
    );
}
