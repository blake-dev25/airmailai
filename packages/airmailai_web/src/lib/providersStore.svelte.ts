import type { OpenRouterModel } from '@airmailai/shared';
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
import { formatErr, reportAppError } from './errorStore.svelte';
import {
    checkApiKeys,
    loadOpenRouterModels,
    refreshOpenRouterModels,
} from './extension';
import { settingsStore } from './settingsStore.svelte';

import { log } from './log';

class ProvidersStore {
    private firstParty = $state<ProviderOption[] | null>(null);
    private openRouter = $state<ProviderOption>(OPENROUTER);
    providers = $derived<ProviderOption[]>(
        this.firstParty
            ? sortProviders([...this.firstParty, this.openRouter])
            : []
    );
    modelsLoadError = $state<string | null>(null);
    savedKeys = $state<Record<string, boolean> | null>(null);
    openRouterCatalogLoading = $state(false);
    openRouterCatalogError = $state<string | null>(null);

    selectedModel = $derived(
        settingsStore.customModel
            ? null
            : (this.providers
                  .find((p) => p.id === settingsStore.providerId)
                  ?.models.find((m) => m.id === settingsStore.modelId) ?? null)
    );

    hasAnyKey = $derived(
        this.savedKeys !== null && Object.values(this.savedKeys).some(Boolean)
    );

    async hydrateModels(): Promise<void> {
        this.modelsLoadError = null;
        try {
            const res = await fetch(MODELS_FILE_PATH, { cache: 'no-cache' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const file = parseModelsFile(await res.json());
            this.firstParty = buildFirstPartyProviders(file);
            log.info('models hydrated', {
                generatedAt: file.generatedAt,
                counts: Object.fromEntries(
                    this.firstParty.map((p) => [p.id, p.models.length])
                ),
            });
        } catch (err) {
            this.modelsLoadError = formatErr(err);
            reportAppError(
                'model list load failed',
                "Couldn't load the model list",
                err
            );
        }
    }

    async refreshSavedKeys(): Promise<void> {
        this.savedKeys = await checkApiKeys(PROVIDER_META.map((p) => p.id));
    }

    async hydrateOpenRouter(): Promise<void> {
        this.openRouterCatalogLoading = true;
        this.openRouterCatalogError = null;
        try {
            const raw = await loadOpenRouterModels();
            if (raw) this.setOpenRouterModels(raw);
        } catch (err) {
            this.openRouterCatalogError = formatErr(err);
            reportAppError(
                'openrouter hydrate failed',
                "Couldn't load OpenRouter models",
                err
            );
        } finally {
            this.openRouterCatalogLoading = false;
        }
    }

    ensureOpenRouterCatalog(): void {
        if (this.savedKeys?.openrouter !== true) return;
        if (this.hasOpenRouterModels() || this.openRouterCatalogLoading) return;
        void this.hydrateOpenRouter();
    }

    async refreshOpenRouterModels(): Promise<void> {
        const raw = await refreshOpenRouterModels();
        this.setOpenRouterModels(raw);
    }

    private setOpenRouterModels(raw: OpenRouterModel[]): void {
        this.openRouter = buildOpenRouterProvider(raw);
        this.openRouterCatalogError = null;
        log.info('openrouter hydrated', `${raw.length} models`);
    }

    hasOpenRouterModels(): boolean {
        return this.openRouter.models.length > 0;
    }

    onApiKeySaved(providerId: string): void {
        this.savedKeys = { ...(this.savedKeys ?? {}), [providerId]: true };
        if (providerId === 'openrouter') this.ensureOpenRouterCatalog();
    }

    onApiKeyCleared(providerId: string): void {
        this.savedKeys = { ...(this.savedKeys ?? {}), [providerId]: false };
    }

    markAllKeysCleared(): void {
        this.savedKeys = Object.fromEntries(
            PROVIDER_META.map((p) => [p.id, false])
        );
    }
}

export const providersStore = new ProvidersStore();
