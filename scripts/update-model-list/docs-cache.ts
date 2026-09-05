import { resolve } from 'node:path';
import { non200Expired } from './probe-cache';
import { SNAPSHOT_DIR } from './shared';

export const DOCS_CACHE_PATH = resolve(SNAPSHOT_DIR, 'docs-cache.json');

type CacheProvider = 'anthropic' | 'openai' | 'google';
const CACHE_PROVIDERS: CacheProvider[] = ['anthropic', 'openai', 'google'];
type CacheSections = Record<CacheProvider, Record<string, unknown>>;

interface DocsCacheOptions {
    refresh: boolean;
    retryNon200: boolean;
}

interface StoredFailure {
    cacheResult: 'non-200';
    code: string;
    cachedAt: number;
}

export interface CachedOutcome<T> {
    code: string;
    value: T | null;
}

export interface DocsCacheSection<T> {
    get(key: string): CachedOutcome<T> | undefined;
    set(key: string, outcome: CachedOutcome<T>): void;
}

export class DocsCache {
    private constructor(
        private readonly sections: CacheSections,
        private readonly options: DocsCacheOptions
    ) {}

    static async load(options: DocsCacheOptions): Promise<DocsCache> {
        const sections: CacheSections = {
            anthropic: {},
            openai: {},
            google: {},
        };
        const file = Bun.file(DOCS_CACHE_PATH);
        if (!(await file.exists())) {
            console.log(
                `no docs cache at ${DOCS_CACHE_PATH} - scraping everything`
            );
            return new DocsCache(sections, options);
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
                ? `ignoring docs cache (${entries} entries) due to --refresh-docs`
                : `loaded docs cache (${entries} entries) from ${DOCS_CACHE_PATH}`
        );
        return new DocsCache(sections, options);
    }

    section<T>(
        provider: CacheProvider,
        namespace?: string
    ): DocsCacheSection<T> {
        const store = this.sections[provider];
        const cacheKey = (key: string): string =>
            namespace ? `${namespace}:${key}` : key;
        return {
            get: (key) => {
                if (this.options.refresh) return undefined;
                const stored = store[cacheKey(key)];
                if (stored === undefined) return undefined;
                if (isStoredFailure(stored)) {
                    if (
                        this.options.retryNon200 ||
                        non200Expired(stored.cachedAt, Date.now())
                    )
                        return undefined;
                    return { code: stored.code, value: null };
                }
                return { code: '200', value: stored as T };
            },
            set: (key, outcome) => {
                if (outcome.code === '200') {
                    if (outcome.value === null) {
                        throw new Error(
                            'Cannot cache a 200 docs result without data'
                        );
                    }
                    store[cacheKey(key)] = outcome.value;
                    return;
                }
                store[cacheKey(key)] = {
                    cacheResult: 'non-200',
                    code: outcome.code,
                    cachedAt: Date.now(),
                } satisfies StoredFailure;
            },
        };
    }

    async save(): Promise<void> {
        await Bun.write(
            DOCS_CACHE_PATH,
            JSON.stringify(this.sections, null, 2)
        );
    }
}

export function splitCached<I, T>(
    items: I[],
    section: DocsCacheSection<T>,
    keyOf: (item: I) => string
): {
    hits: Array<{ item: I; parsed: T }>;
    failures: Array<{ item: I; code: string }>;
    misses: I[];
} {
    const hits: Array<{ item: I; parsed: T }> = [];
    const failures: Array<{ item: I; code: string }> = [];
    const misses: I[] = [];
    for (const item of items) {
        const outcome = section.get(keyOf(item));
        if (outcome === undefined) {
            misses.push(item);
        } else if (outcome.value === null) {
            failures.push({ item, code: outcome.code });
        } else {
            hits.push({ item, parsed: outcome.value });
        }
    }
    return { hits, failures, misses };
}

function isStoredFailure(value: unknown): value is StoredFailure {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<StoredFailure>;
    return (
        candidate.cacheResult === 'non-200' &&
        typeof candidate.code === 'string' &&
        typeof candidate.cachedAt === 'number'
    );
}
