import { AsyncResource } from './asyncResource.svelte';
import {
    buildFirstPartyProviders,
    buildOpenRouterProvider,
    MODELS_FILE_PATH,
    OPENROUTER,
    parseModelsFile,
    PROVIDER_META,
    type ProviderOption,
    sortProviders,
} from './constants';
import {
    checkApiKeys,
    loadOpenRouterModels,
    refreshOpenRouterModels,
} from './extension';
import { settingsStore } from './settingsStore.svelte';

import { log } from './log';

async function fetchFirstPartyProviders(): Promise<ProviderOption[]> {
    const res = await fetch(MODELS_FILE_PATH, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const file = parseModelsFile(await res.json());
    const providers = buildFirstPartyProviders(file);
    log.info('models hydrated', {
        generatedAt: file.generatedAt,
        counts: Object.fromEntries(
            providers.map((p) => [p.id, p.models.length])
        ),
    });
    return providers;
}

async function fetchOpenRouterProvider(): Promise<ProviderOption> {
    const raw = await loadOpenRouterModels();
    if (!raw) return OPENROUTER;
    log.info('openrouter hydrated', `${raw.length} models`);
    return buildOpenRouterProvider(raw);
}

class ProvidersStore {
    firstParty = new AsyncResource<ProviderOption[]>();
    openRouterCatalog = new AsyncResource<ProviderOption>();
    savedKeys = new AsyncResource<Record<string, boolean>>();

    providers = $derived<ProviderOption[]>(
        this.firstParty.value
            ? sortProviders([
                  ...this.firstParty.value,
                  this.openRouterCatalog.value ?? OPENROUTER,
              ])
            : []
    );

    selectedModel = $derived(
        settingsStore.customModel
            ? null
            : (this.providers
                  .find((p) => p.id === settingsStore.providerId)
                  ?.models.find((m) => m.id === settingsStore.modelId) ?? null)
    );

    hasAnyKey = $derived(
        Object.values(this.savedKeys.value ?? {}).some(Boolean)
    );

    hasSavedKey(providerId: string): boolean {
        return this.savedKeys.value?.[providerId] === true;
    }

    async hydrateModels(): Promise<void> {
        await this.firstParty.load(fetchFirstPartyProviders, {
            context: 'model list load failed',
            userMessage: "Couldn't load the model list",
        });
    }

    async refreshSavedKeys(): Promise<void> {
        await this.savedKeys.load(
            () => checkApiKeys(PROVIDER_META.map((p) => p.id)),
            {
                context: 'saved key check failed',
                userMessage: "Couldn't read saved API keys",
            }
        );
    }

    async hydrateOpenRouter(): Promise<void> {
        await this.openRouterCatalog.load(fetchOpenRouterProvider, {
            context: 'openrouter hydrate failed',
            userMessage: "Couldn't load OpenRouter models",
        });
    }

    ensureOpenRouterCatalog(): void {
        if (!this.hasSavedKey('openrouter')) return;
        if (
            this.hasOpenRouterModels() ||
            this.openRouterCatalog.state.status === 'loading'
        )
            return;
        void this.hydrateOpenRouter();
    }

    async refreshOpenRouterModels(): Promise<void> {
        const raw = await refreshOpenRouterModels();
        this.openRouterCatalog.set(buildOpenRouterProvider(raw));
        log.info('openrouter refreshed', `${raw.length} models`);
    }

    hasOpenRouterModels(): boolean {
        return (this.openRouterCatalog.value?.models.length ?? 0) > 0;
    }

    private setSavedKey(providerId: string, saved: boolean): void {
        this.savedKeys.set({
            ...(this.savedKeys.value ?? {}),
            [providerId]: saved,
        });
    }

    onApiKeySaved(providerId: string): void {
        this.setSavedKey(providerId, true);
        if (providerId === 'openrouter') this.ensureOpenRouterCatalog();
    }

    onApiKeyCleared(providerId: string): void {
        this.setSavedKey(providerId, false);
    }

    markAllKeysCleared(): void {
        this.savedKeys.set(
            Object.fromEntries(PROVIDER_META.map((p) => [p.id, false]))
        );
    }
}

export const providersStore = new ProvidersStore();
