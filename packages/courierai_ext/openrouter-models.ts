import type { OpenRouterModel } from '@courier/shared';

const LOG = '[courier:ext]';

// Stale-while-revalidate window. Within FRESH_MS we never hit the network;
// past it we serve stale instantly and refresh in the background.
const FRESH_MS = 24 * 60 * 60 * 1000;
// On fetch error we set a cooldown so successive picker opens can't hammer
// openrouter.ai. Stale cache (if any) keeps serving in the meantime.
const ERROR_COOLDOWN_MS = 5 * 60 * 1000;

const CACHE_KEY = 'openrouter_models_cache';
const URL = 'https://openrouter.ai/api/v1/models?output_modalities=text';

interface CacheEntry {
    models: OpenRouterModel[];
    fetchedAt: number;
    nextRetryAt?: number;
}

interface RawModel {
    id: string;
    name: string;
    created: number;
    context_length?: number;
    architecture?: { input_modalities?: string[] };
    top_provider?: { context_length?: number; max_completion_tokens?: number };
    supported_parameters?: string[];
}

const PARAMS_OF_INTEREST = new Set([
    'tools',
    'reasoning',
    'response_format',
    'structured_outputs',
    'temperature',
    'top_p',
    'max_tokens',
]);

function slim(raw: RawModel): OpenRouterModel | null {
    if (!raw.id || !raw.name) return null;
    const ctx = raw.top_provider?.context_length ?? raw.context_length ?? 0;
    const out = raw.top_provider?.max_completion_tokens ?? 0;
    if (!ctx || !out) return null;
    const vendor = raw.id.split('/')[0] ?? 'unknown';
    return {
        id: raw.id,
        name: raw.name,
        vendor,
        contextWindow: ctx,
        maxOutputTokens: out,
        inputModalities: raw.architecture?.input_modalities ?? ['text'],
        supportedParams: (raw.supported_parameters ?? []).filter((p) =>
            PARAMS_OF_INTEREST.has(p)
        ),
        free: raw.id.endsWith(':free'),
        created: raw.created ?? 0,
    };
}

async function fetchAndSlim(): Promise<OpenRouterModel[]> {
    const res = await fetch(URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { data: RawModel[] };
    const models = (json.data ?? [])
        .map(slim)
        .filter((m): m is OpenRouterModel => m !== null);
    console.log(LOG, 'openrouter: fetched', models.length, 'models');
    return models;
}

async function readCache(): Promise<CacheEntry | null> {
    const result = await chrome.storage.local.get(CACHE_KEY);
    return (result[CACHE_KEY] as CacheEntry | undefined) ?? null;
}

async function writeCache(entry: CacheEntry): Promise<void> {
    await chrome.storage.local.set({ [CACHE_KEY]: entry });
}

// Returns the freshest models we can serve right now. Caller never blocks on
// the network when stale cache exists — we kick off a background refresh and
// return the stale list immediately.
export async function getOpenRouterModels(): Promise<OpenRouterModel[] | null> {
    const cache = await readCache();
    const now = Date.now();

    if (cache && now - cache.fetchedAt < FRESH_MS) {
        return cache.models;
    }

    if (cache?.nextRetryAt && now < cache.nextRetryAt) {
        // In error cooldown — keep serving stale even if past FRESH_MS.
        return cache.models.length > 0 ? cache.models : null;
    }

    if (cache) {
        // Stale-while-revalidate: serve stale, refresh in background.
        refreshInBackground();
        return cache.models;
    }

    // Cold start — must wait for the first fetch.
    try {
        const models = await fetchAndSlim();
        await writeCache({ models, fetchedAt: now });
        return models;
    } catch (e) {
        console.error(LOG, 'openrouter: cold fetch failed', e);
        await writeCache({
            models: [],
            fetchedAt: 0,
            nextRetryAt: now + ERROR_COOLDOWN_MS,
        });
        return null;
    }
}

let refreshing = false;
function refreshInBackground(): void {
    if (refreshing) return;
    refreshing = true;
    fetchAndSlim()
        .then((models) =>
            writeCache({ models, fetchedAt: Date.now() }).catch(() => {})
        )
        .catch(async (e) => {
            console.error(LOG, 'openrouter: background refresh failed', e);
            const cache = await readCache();
            if (cache) {
                await writeCache({
                    ...cache,
                    nextRetryAt: Date.now() + ERROR_COOLDOWN_MS,
                });
            }
        })
        .finally(() => {
            refreshing = false;
        });
}
