import type { OpenRouterModel } from '@courierai/shared';
import { log } from './debug';

const FRESH_MS = 24 * 60 * 60 * 1000;
const ERROR_COOLDOWN_MS = 5 * 60 * 1000;
export const CACHE_VERSION = 3;

export const CACHE_KEY = 'openrouter_models_cache';
const URL = 'https://openrouter.ai/api/v1/models/user';

interface CacheEntry {
    version: number;
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
    'temperature',
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

async function fetchAndSlim(apiKey: string): Promise<OpenRouterModel[]> {
    const res = await fetch(URL, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { data: RawModel[] };
    const models = (json.data ?? [])
        .map(slim)
        .filter((m): m is OpenRouterModel => m !== null);
    log.info('openrouter: fetched', models.length, 'models');
    return models;
}

async function readCache(): Promise<CacheEntry | null> {
    const result = await chrome.storage.local.get(CACHE_KEY);
    const entry = result[CACHE_KEY] as CacheEntry | undefined;
    if (!entry || entry.version !== CACHE_VERSION) return null;
    return entry;
}

async function writeCache(entry: CacheEntry): Promise<void> {
    await chrome.storage.local.set({ [CACHE_KEY]: entry });
}

export async function getOpenRouterModels(
    apiKey?: string
): Promise<OpenRouterModel[] | null> {
    const cache = await readCache();
    const now = Date.now();

    if (!apiKey) {
        return cache && cache.models.length > 0 ? cache.models : null;
    }

    if (cache && cache.models.length > 0) {
        if (now - cache.fetchedAt < FRESH_MS) return cache.models;
        if (cache.nextRetryAt && now < cache.nextRetryAt) return cache.models;
        refreshInBackground(apiKey);
        return cache.models;
    }

    if (cache?.nextRetryAt && now < cache.nextRetryAt) {
        return null;
    }

    try {
        const models = await fetchAndSlim(apiKey);
        await writeCache({ version: CACHE_VERSION, models, fetchedAt: now });
        return models;
    } catch (e) {
        log.error('openrouter: cold fetch failed', e);
        await writeCache({
            version: CACHE_VERSION,
            models: [],
            fetchedAt: 0,
            nextRetryAt: now + ERROR_COOLDOWN_MS,
        });
        throw e instanceof Error
            ? e
            : new Error(`OpenRouter fetch failed: ${String(e)}`);
    }
}

let refreshing = false;
function refreshInBackground(apiKey: string): void {
    if (refreshing) return;
    refreshing = true;
    fetchAndSlim(apiKey)
        .then((models) =>
            writeCache({
                version: CACHE_VERSION,
                models,
                fetchedAt: Date.now(),
            }).catch(() => {})
        )
        .catch(async (e) => {
            log.error('openrouter: background refresh failed', e);
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
