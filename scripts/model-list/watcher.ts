import { fetchAnthropicModelIds } from './anthropic';
import { fetchGoogleModelIds } from './google';
import { errorMessage } from './http';
import { fetchOpenAIModelIds } from './openai';
import type { Provider } from './shared';
import type { StateStore } from './state-store';
import { ALL_PROVIDERS } from './update';

export const WATCHER_STATE_KEY = 'watcher-state.json';

export type ObservedModelIds = Partial<Record<Provider, string[]>>;

export interface WatcherReport {
    observedIds: ObservedModelIds;
    counts: Partial<Record<Provider, number>>;
    newIds: Partial<Record<Provider, string[]>>;
    errors: Partial<Record<Provider, string>>;
}

const FETCHERS: Record<Provider, () => Promise<string[]>> = {
    anthropic: fetchAnthropicModelIds,
    openai: fetchOpenAIModelIds,
    google: fetchGoogleModelIds,
};

export function parseObservedModelIds(
    value: unknown,
    location: string
): ObservedModelIds {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${location}: expected provider model ID lists`);
    }
    const parsed = value as Record<string, unknown>;
    const state: ObservedModelIds = {};
    for (const provider of ALL_PROVIDERS) {
        const ids = parsed[provider];
        if (ids === undefined) continue;
        if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
            throw new Error(`${location}: ${provider} is not a string array`);
        }
        state[provider] = ids;
    }
    return state;
}

async function loadState(store: StateStore): Promise<ObservedModelIds> {
    const text = await store.read(WATCHER_STATE_KEY);
    if (text === null) {
        console.log(
            `no watcher state at ${store.describe(WATCHER_STATE_KEY)} - every model will count as new`
        );
        return {};
    }
    return parseObservedModelIds(
        JSON.parse(text),
        store.describe(WATCHER_STATE_KEY)
    );
}

export async function acknowledgeModels(
    store: StateStore,
    observedIds: ObservedModelIds,
    providers: readonly Provider[]
): Promise<void> {
    if (!providers.some((provider) => observedIds[provider] !== undefined))
        return;
    await store.update(WATCHER_STATE_KEY, (text) => {
        const state =
            text === null
                ? {}
                : parseObservedModelIds(
                      JSON.parse(text),
                      store.describe(WATCHER_STATE_KEY)
                  );
        for (const provider of providers) {
            const ids = observedIds[provider];
            if (!ids) continue;
            state[provider] = [
                ...new Set([...(state[provider] ?? []), ...ids]),
            ].sort();
        }
        return JSON.stringify(state, null, 2) + '\n';
    });
}

export function providersWithNewModels(report: WatcherReport): Provider[] {
    return ALL_PROVIDERS.filter((p) => (report.newIds[p]?.length ?? 0) > 0);
}

export async function runWatcher(store: StateStore): Promise<WatcherReport> {
    const previous = await loadState(store);
    const started = Date.now();
    const results = await Promise.allSettled(
        ALL_PROVIDERS.map((provider) => FETCHERS[provider]())
    );
    console.log(`fetched provider model lists in ${Date.now() - started}ms`);

    const report: WatcherReport = {
        observedIds: {},
        counts: {},
        newIds: {},
        errors: {},
    };
    ALL_PROVIDERS.forEach((provider, i) => {
        const result = results[i];
        if (result.status === 'rejected') {
            report.errors[provider] = errorMessage(result.reason);
            console.log(
                `ERROR ${provider} fetch failed: ${report.errors[provider]}`
            );
            return;
        }
        const current = result.value;
        const seen = new Set(previous[provider] ?? []);
        const fresh = current.filter((id) => !seen.has(id));
        report.counts[provider] = current.length;
        report.newIds[provider] = fresh;
        report.observedIds[provider] = current;
        console.log(
            fresh.length > 0
                ? `got ${current.length} models from ${provider}, ${fresh.length} new: ${fresh.join(', ')}`
                : `got ${current.length} models from ${provider}, no changes`
        );
    });

    return report;
}
