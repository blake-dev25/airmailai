import { untrack } from 'svelte';
import { detectBrowser } from './browser';
import { startBroadcastBridge } from './broadcastBridge.svelte';
import { chatStore } from './chatStore.svelte';
import {
    defaultModelForProvider,
    filterProvidersByTier,
    type ModelTier,
} from './constants';
import { reportAppError } from './errorStore.svelte';
import { getExtensionVersion, waitForExtension } from './extension';
import { providersStore } from './providersStore.svelte';
import { settingsStore } from './settingsStore.svelte';
import { versionCheck } from './versionCheck.svelte';

import { log } from './log';

class AppLifecycle {
    initialized = $state(false);
    view = $state<'chat' | 'files'>('chat');
    showExtensionPrompt = $state(false);
    showLegalGate = $state(false);
    promptVariant = $state<'no-extension' | 'unsupported-browser' | 'mobile'>(
        'no-extension'
    );

    private lastSnappedTier: ModelTier | null = null;
    private stopBridge: (() => void) | null = null;
    private markReady: () => void = () => {};
    readonly ready = new Promise<void>((resolve) => {
        this.markReady = resolve;
    });

    constructor() {
        $effect.root(() => {
            $effect(() => {
                const tier = settingsStore.modelTier;
                if (!settingsStore.settingsLoaded) return;
                if (this.lastSnappedTier === null) {
                    this.lastSnappedTier = tier;
                    return;
                }
                if (tier === this.lastSnappedTier) return;
                this.lastSnappedTier = tier;
                untrack(() => {
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

        const detected = await waitForExtension();
        if (!detected) {
            const browser = detectBrowser();
            this.promptVariant =
                browser === 'mobile'
                    ? 'mobile'
                    : browser === 'other-desktop'
                      ? 'unsupported-browser'
                      : 'no-extension';
            this.showExtensionPrompt = true;
        }
        log.info('extension detected:', detected);

        if (detected) {
            const extVersion = getExtensionVersion();
            versionCheck.checkExtAtStartup(
                extVersion.version,
                extVersion.versionName
            );

            providersStore.hydrateOpenRouter().catch((err) => {
                reportAppError(
                    'openrouter hydrate failed',
                    "Couldn't load OpenRouter models",
                    err
                );
            });
            providersStore.refreshSavedKeys().catch((err) => {
                reportAppError(
                    'saved key check failed',
                    "Couldn't check saved API keys",
                    err
                );
            });

            await settingsStore.load();
            await chatStore.loadChats();

            settingsStore.applyToolDefaults(providersStore.selectedModel);

            if (settingsStore.legalAcceptedVersion !== __LEGAL_VERSION__) {
                this.showLegalGate = true;
                log.info('legal gate', {
                    acceptedVersion: settingsStore.legalAcceptedVersion,
                    currentVersion: __LEGAL_VERSION__,
                });
            }
        }

        this.initialized = true;

        if (detected) this.stopBridge = startBroadcastBridge();
    }

    enterDemoMode(): void {
        settingsStore.paused = true;
        chatStore.loadDemo();
        this.showExtensionPrompt = false;
    }

    requestExtension(): void {
        this.showExtensionPrompt = true;
    }

    handleLegalAgree(): void {
        settingsStore.persistLegalVersion(__LEGAL_VERSION__);
        this.showLegalGate = false;
        log.info('legal agreed', __LEGAL_VERSION__);
    }
}

export const appLifecycle = new AppLifecycle();
