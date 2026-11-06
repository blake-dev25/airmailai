import { untrack } from 'svelte';
import { appMode, type ExtensionPromptVariant } from './appMode.svelte';
import { detectBrowser } from './browser';
import { startBroadcastBridge } from './broadcastBridge.svelte';
import { chatStore } from './chatStore.svelte';
import {
    defaultModelForProvider,
    filterProvidersByTier,
    type ModelTierFilter,
} from './constants';
import { getExtensionVersion, waitForExtension } from './extension';
import { providersStore } from './providersStore.svelte';
import { settingsStore } from './settingsStore.svelte';
import { versionCheck } from './versionCheck.svelte';

import { log } from './log';

function missingExtensionVariant(): ExtensionPromptVariant {
    const browser = detectBrowser();
    if (browser === 'mobile') return 'mobile';
    if (browser === 'other-desktop') return 'unsupported-browser';
    return 'no-extension';
}

class AppLifecycle {
    bootPhase = $state<'booting' | 'ready'>('booting');
    view = $state<'chat' | 'files'>('chat');
    showLegalGate = $derived(
        this.bootPhase === 'ready' &&
            appMode.extension.kind === 'connected' &&
            settingsStore.legalAcceptedVersion !== __LEGAL_VERSION__
    );

    private lastSnappedTier: ModelTierFilter | null = null;
    private stopBridge: (() => void) | null = null;
    private markReady: () => void = () => {};
    readonly ready = new Promise<void>((resolve) => {
        this.markReady = resolve;
    });

    constructor() {
        $effect.root(() => {
            $effect(() => {
                const tier = settingsStore.modelTier;
                if (settingsStore.loadState !== 'loaded') return;
                if (this.lastSnappedTier === null) {
                    this.lastSnappedTier = tier;
                    return;
                }
                if (tier === this.lastSnappedTier) return;
                this.lastSnappedTier = tier;
                untrack(() => {
                    if (settingsStore.customModel) return;
                    const active = chatStore.chats.find(
                        (c) => c.id === chatStore.activeChatId
                    );
                    if ((active?.messages.length ?? 0) > 0) return;
                    const filtered = filterProvidersByTier(
                        providersStore.providers,
                        tier
                    );
                    const provider = filtered.find(
                        (p) => p.id === settingsStore.providerId
                    );
                    if (!provider) {
                        const fallback =
                            filtered[0] ?? providersStore.providers[0];
                        if (!fallback) return;
                        const model = defaultModelForProvider(fallback);
                        if (!model) return;
                        settingsStore.providerId = fallback.id;
                        settingsStore.modelId = model.id;
                        return;
                    }
                    if (
                        !provider.models.find(
                            (m) => m.id === settingsStore.modelId
                        )
                    ) {
                        const model = defaultModelForProvider(provider);
                        if (!model) return;
                        settingsStore.modelId = model.id;
                    }
                });
            });
        });
    }

    async start(): Promise<void> {
        try {
            await this.initialize();
        } finally {
            this.markReady();
        }
    }

    private async initialize(): Promise<void> {
        log.info('page load', {
            screen: `${window.screen.width}x${window.screen.height}`,
            time: new Date().toISOString(),
        });

        const modelsReady = providersStore.hydrateModels();
        const detected = await waitForExtension();
        appMode.extension = detected
            ? { kind: 'connected' }
            : { kind: 'missing', variant: missingExtensionVariant() };
        log.info('extension detected:', detected);

        if (detected) {
            const extVersion = getExtensionVersion();
            versionCheck.checkExtAtStartup(
                extVersion.version,
                extVersion.versionName
            );

            void providersStore.hydrateOpenRouter();
            void providersStore.refreshSavedKeys();

            await settingsStore.load();
            await chatStore.loadChats();
        }

        await modelsReady;
        settingsStore.reconcileModelSelection(providersStore.providers);
        settingsStore.applyToolDefaults(providersStore.selectedModel);
        this.bootPhase = 'ready';
        if (this.showLegalGate) {
            log.info('legal gate', {
                acceptedVersion: settingsStore.legalAcceptedVersion,
                currentVersion: __LEGAL_VERSION__,
            });
        }

        if (detected) this.stopBridge = startBroadcastBridge();
    }

    enterDemoMode(): void {
        const mode = appMode.extension;
        if (mode.kind === 'demo') {
            appMode.extension = { ...mode, promptOpen: false };
            return;
        }
        if (mode.kind !== 'missing') return;
        appMode.extension = {
            kind: 'demo',
            variant: mode.variant,
            promptOpen: false,
        };
        chatStore.loadDemo();
    }

    requestExtension(): void {
        const mode = appMode.extension;
        if (mode.kind !== 'demo') return;
        appMode.extension = { ...mode, promptOpen: true };
    }

    handleLegalAgree(): void {
        settingsStore.persistLegalVersion(__LEGAL_VERSION__);
        log.info('legal agreed', __LEGAL_VERSION__);
    }
}

export const appLifecycle = new AppLifecycle();
