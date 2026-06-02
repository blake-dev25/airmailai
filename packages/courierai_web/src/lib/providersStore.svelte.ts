import {
    buildOpenRouterProvider,
    PROVIDERS,
    type ProviderOption,
} from './constants';
import { reportAppError } from './errorStore.svelte';
import { loadOpenRouterModels } from './extension';
import { settingsStore } from './settingsStore.svelte';

const LOG = '[courierai:web]';

class ProvidersStore {
    // OpenRouter's catalog hydrates async; the rest are static. The local
    // state lets us swap the OpenRouter entry once it's ready without
    // re-rendering the world.
    providers = $state<ProviderOption[]>(PROVIDERS);

    selectedModel = $derived(
        this.providers
            .find((p) => p.id === settingsStore.providerId)
            ?.models.find((m) => m.id === settingsStore.modelId) ?? null
    );

    async hydrateOpenRouter(): Promise<void> {
        const raw = await loadOpenRouterModels();
        if (!raw || raw.length === 0) return;
        const built = buildOpenRouterProvider(raw);
        this.providers = this.providers.map((p) =>
            p.id === 'openrouter' ? built : p
        );
        console.log(LOG, 'openrouter hydrated', `${raw.length} models`);
    }

    hasOpenRouterModels(): boolean {
        return (
            (this.providers.find((p) => p.id === 'openrouter')?.models.length ??
                0) > 0
        );
    }

    onApiKeySaved(providerId: string): void {
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

    // Keep any downloaded OpenRouter catalog available; only the key goes away.
    onApiKeyCleared(_providerId: string): void {}
}

export const providersStore = new ProvidersStore();
