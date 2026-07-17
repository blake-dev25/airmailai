import {
    buildOpenRouterProvider,
    PROVIDERS,
    type ProviderOption,
} from './constants';
import { reportAppError } from './errorStore.svelte';
import { checkApiKeys, loadOpenRouterModels } from './extension';
import { settingsStore } from './settingsStore.svelte';

import { log } from './log';

class ProvidersStore {
    providers = $state<ProviderOption[]>(PROVIDERS);
    savedKeys = $state<Record<string, boolean> | null>(null);

    selectedModel = $derived(
        this.providers
            .find((p) => p.id === settingsStore.providerId)
            ?.models.find((m) => m.id === settingsStore.modelId) ?? null
    );

    hasAnyKey = $derived(
        this.savedKeys !== null && Object.values(this.savedKeys).some(Boolean)
    );

    async refreshSavedKeys(): Promise<void> {
        this.savedKeys = await checkApiKeys(PROVIDERS.map((p) => p.id));
    }

    async hydrateOpenRouter(): Promise<void> {
        const raw = await loadOpenRouterModels();
        if (!raw || raw.length === 0) return;
        const built = buildOpenRouterProvider(raw);
        this.providers = this.providers.map((p) =>
            p.id === 'openrouter' ? built : p
        );
        log.info('openrouter hydrated', `${raw.length} models`);
    }

    hasOpenRouterModels(): boolean {
        return (
            (this.providers.find((p) => p.id === 'openrouter')?.models.length ??
                0) > 0
        );
    }

    onApiKeySaved(providerId: string): void {
        this.savedKeys = { ...(this.savedKeys ?? {}), [providerId]: true };
        if (providerId === 'openrouter' && !this.hasOpenRouterModels()) {
            this.hydrateOpenRouter().catch((err) => {
                reportAppError(
                    'openrouter hydrate failed',
                    "Couldn't load OpenRouter models",
                    err
                );
            });
        }
    }

    onApiKeyCleared(providerId: string): void {
        this.savedKeys = { ...(this.savedKeys ?? {}), [providerId]: false };
    }

    markAllKeysCleared(): void {
        this.savedKeys = Object.fromEntries(
            PROVIDERS.map((p) => [p.id, false])
        );
    }
}

export const providersStore = new ProvidersStore();
