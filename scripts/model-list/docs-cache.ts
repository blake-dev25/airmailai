import { cacheExpired } from './probe-cache';
import type { Provider } from './shared';
import type { StateStore } from './state-store';

export const DOCS_CACHE_KEY = 'docs-cache.json';

const CACHE_PROVIDERS: Provider[] = ['anthropic', 'openai', 'google'];
type CacheSections = Record<Provider, Record<string, unknown>>;

interface DocsCacheOptions {
    refresh: boolean;
    retryNon200: boolean;
}

export const UNPARSED_DOCS_CODE = 'unparsed';

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
    keys(): string[];
    get(key: string): CachedOutcome<T> | undefined;
    set(key: string, outcome: CachedOutcome<T>): void;
}

export class DocsCache {
    private constructor(
        private readonly store: StateStore,
        private readonly sections: CacheSections,
        private readonly options: DocsCacheOptions
    ) {}

    static async load(
        store: StateStore,
        options: DocsCacheOptions
    ): Promise<DocsCache> {
        const sections: CacheSections = {
            anthropic: {},
            openai: {},
            google: {},
        };
        const location = store.describe(DOCS_CACHE_KEY);
        const text = await store.read(DOCS_CACHE_KEY);
        if (text === null) {
            console.log(`no docs cache at ${location} - scraping everything`);
            return new DocsCache(store, sections, options);
        }
        const parsed = JSON.parse(text) as Partial<CacheSections>;
        let entries = 0;
        const malformed: string[] = [];
        for (const provider of CACHE_PROVIDERS) {
            const section = parsed[provider];
            if (!section || typeof section !== 'object') continue;
            for (const [key, value] of Object.entries(section)) {
                if (isFailureShaped(value) && !isStoredFailure(value)) {
                    malformed.push(`${provider}/${key}`);
                }
            }
            entries += Object.keys(section).length;
            sections[provider] = section;
        }
        if (malformed.length > 0) {
            throw new Error(
                `${malformed.length} malformed docs cache entry/entries in ${location} - delete them to re-scrape:\n${malformed.map((k) => `   - ${k}`).join('\n')}`
            );
        }
        console.log(
            options.refresh
                ? `ignoring docs cache (${entries} entries) due to --refresh-docs`
                : `loaded docs cache (${entries} entries) from ${location}`
        );
        return new DocsCache(store, sections, options);
    }

    section<T>(
        provider: Provider,
        isComplete: (value: T) => boolean = () => true
    ): DocsCacheSection<T> {
        const store = this.sections[provider];
        const storeFailure = (key: string, code: string) => {
            store[key] = {
                cacheResult: 'non-200',
                code,
                cachedAt: Date.now(),
            } satisfies StoredFailure;
        };
        return {
            keys: () => Object.keys(store),
            get: (key) => {
                if (this.options.refresh) return undefined;
                const stored = store[key];
                if (stored === undefined) return undefined;
                if (isStoredFailure(stored)) {
                    if (
                        this.options.retryNon200 ||
                        cacheExpired(stored.cachedAt, Date.now())
                    )
                        return undefined;
                    return { code: stored.code, value: null };
                }
                if (!isComplete(stored as T)) return undefined;
                return { code: '200', value: stored as T };
            },
            set: (key, outcome) => {
                if (outcome.code !== '200') {
                    storeFailure(key, outcome.code);
                    return;
                }
                if (outcome.value === null) {
                    throw new Error(
                        'Cannot cache a 200 docs result without data'
                    );
                }
                if (isComplete(outcome.value)) store[key] = outcome.value;
                else storeFailure(key, UNPARSED_DOCS_CODE);
            },
        };
    }

    async save(): Promise<void> {
        await this.store.write(
            DOCS_CACHE_KEY,
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

function isFailureShaped(value: unknown): boolean {
    return !!value && typeof value === 'object' && 'cacheResult' in value;
}

function isStoredFailure(value: unknown): value is StoredFailure {
    if (!isFailureShaped(value)) return false;
    const candidate = value as Partial<StoredFailure>;
    return (
        candidate.cacheResult === 'non-200' &&
        typeof candidate.code === 'string' &&
        typeof candidate.cachedAt === 'number'
    );
}
