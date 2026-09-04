import { resolve } from 'node:path';
import { SNAPSHOT_DIR } from './shared';

export const DOCS_CACHE_PATH = resolve(SNAPSHOT_DIR, 'docs-cache.json');

type CacheProvider = 'anthropic' | 'openai' | 'google';
const CACHE_PROVIDERS: CacheProvider[] = ['anthropic', 'openai', 'google'];
type CacheSections = Record<CacheProvider, Record<string, unknown>>;

export interface DocsCacheSection<T> {
    get(key: string): T | undefined;
    set(key: string, value: T): void;
}

export class DocsCache {
    private constructor(private readonly sections: CacheSections) {}

    static async load(refresh: boolean): Promise<DocsCache> {
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
            return new DocsCache(sections);
        }
        const parsed = JSON.parse(await file.text()) as Partial<CacheSections>;
        let entries = 0;
        for (const provider of CACHE_PROVIDERS) {
            const section = parsed[provider];
            if (!section || typeof section !== 'object') continue;
            entries += Object.keys(section).length;
            if (!refresh) sections[provider] = section;
        }
        console.log(
            refresh
                ? `ignoring docs cache (${entries} entries) due to --refresh-docs`
                : `loaded docs cache (${entries} entries) from ${DOCS_CACHE_PATH}`
        );
        return new DocsCache(sections);
    }

    section<T>(provider: CacheProvider): DocsCacheSection<T> {
        const store = this.sections[provider];
        return {
            get: (key) => store[key] as T | undefined,
            set: (key, value) => {
                store[key] = value;
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
): { hits: Array<{ item: I; parsed: T }>; misses: I[] } {
    const hits: Array<{ item: I; parsed: T }> = [];
    const misses: I[] = [];
    for (const item of items) {
        const parsed = section.get(keyOf(item));
        if (parsed === undefined) misses.push(item);
        else hits.push({ item, parsed });
    }
    return { hits, misses };
}
