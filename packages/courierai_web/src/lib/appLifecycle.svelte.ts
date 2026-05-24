import { untrack } from 'svelte';
import { detectBrowser } from './browser';
import { startBroadcastBridge } from './broadcastBridge.svelte';
import { chatStore } from './chatStore.svelte';
import { filterProvidersByTier, type ModelTier } from './constants';
import { reportAppError } from './errorStore.svelte';
import { waitForExtension } from './extension';
import { providersStore } from './providersStore.svelte';
import { settingsStore } from './settingsStore.svelte';

const LOG = '[courier:web]';

class AppLifecycle {
    // Flips true after the initial extension/settings/chats load completes
    // (or times out into the no-extension path). Gates UI sections that would
    // otherwise flash defaults before the real data arrives.
    initialized = $state(false);
    showExtensionPrompt = $state(false);
    showLegalGate = $state(false);
    promptVariant = $state<'no-extension' | 'unsupported-browser' | 'mobile'>(
        'no-extension'
    );

    private lastSnappedTier: ModelTier | null = null;
    private stopBridge: (() => void) | null = null;

    constructor() {
        $effect.root(() => {
            // When the user changes tier and the active model is no longer in
            // the filtered list, snap to the first model of the first filtered
            // provider. Skip the snap when the active chat already has
            // messages — the stored model is the source of truth and stays
            // visible even if out-of-tier.
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
                        settingsStore.providerId = fallback.id;
                        settingsStore.modelId = fallback.models[0].id;
                        return;
                    }
                    if (
                        !provider.models.find(
                            (m) => m.id === settingsStore.modelId
                        )
                    ) {
                        if (!provider.models[0]) return;
                        settingsStore.modelId = provider.models[0].id;
                    }
                });
            });
        });
    }

    async start(): Promise<void> {
        console.log(LOG, 'page load', {
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
        console.log(LOG, 'extension detected:', detected);

        // When the extension isn't installed, skip every ext-bound call —
        // they'd all reject with "Extension not detected" and spam the error
        // banner. UI runs on defaults until the user installs and reloads.
        // Mid-session ext death is still surfaced loudly: runtime ops (save,
        // load, etc.) fail at message-send time and flow through setAppError.
        if (detected) {
            // Fire-and-forget: doesn't gate `initialized` since the rest of
            // the UI works without OpenRouter. Without a key this is
            // cache-only, so it never makes an unauthenticated OpenRouter
            // request.
            providersStore.hydrateOpenRouter().catch((err) => {
                reportAppError(
                    'openrouter hydrate failed',
                    "Couldn't load OpenRouter models",
                    err
                );
            });

            await Promise.all([
                settingsStore.load(),
                chatStore.loadInitialPage(),
            ]);

            if (settingsStore.legalAcceptedVersion !== __LEGAL_VERSION__) {
                this.showLegalGate = true;
                console.log(LOG, 'legal gate', {
                    acceptedVersion: settingsStore.legalAcceptedVersion,
                    currentVersion: __LEGAL_VERSION__,
                });
            }
        }

        this.initialized = true;

        if (detected) this.stopBridge = startBroadcastBridge();
    }

    enterDemoMode(): void {
        // Pause settings persistence so demo edits don't overwrite real
        // saved settings.
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
        console.log(LOG, 'legal agreed', __LEGAL_VERSION__);
    }
}

export const appLifecycle = new AppLifecycle();
