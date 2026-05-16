import { SETTINGS_KEYS, type UserSettings } from '@courier/shared';
import { untrack } from 'svelte';
import { FONT_SIZES, type ModelTier, PROVIDERS } from './constants';
import { errorStore, formatErr } from './errorStore.svelte';
import {
    loadSettings as loadFromExt,
    saveSettings as saveToExtRaw,
} from './extension';

const LOG = '[courier:web]';

function saveToExt(snapshot: Partial<UserSettings>): void {
    saveToExtRaw(snapshot).catch((err) => {
        console.error(LOG, 'settings save failed', err);
        errorStore.setAppError(`Couldn't save settings: ${formatErr(err)}`);
    });
}

function getDefaultFontSizeIndex(): number {
    const w = window.screen.width;
    if (w <= 1366) return 1; // 16px — small laptop
    if (w <= 1920) return 2; // 18px — standard
    return 2; // 18px — large/4K
}

const defaultModel = PROVIDERS[0].models[1]; // Sonnet as default

class SettingsStore {
    // UI
    theme = $state('airmail-warm');
    fontSizeIndex = $state(getDefaultFontSizeIndex());
    chatWidth = $state(0);
    smoothTextMode = $state<
        'smooth' | 'boost-on-complete' | 'dump-on-complete' | 'raw'
    >('smooth');
    submitKeystroke = $state<'enter' | 'ctrl+enter'>('enter');

    // Behavior
    modelTier = $state<ModelTier>('latest');
    autoscroll = $state(false);
    enableWebSearch = $state(false);
    tagOpenRouterRequests = $state(false);
    syncApiKeys = $state(false);
    legalAcceptedVersion = $state('');

    // Active chat config — these mirror the current chat's settings and act
    // as defaults for new chats. They're persisted (mostly) as user settings
    // so a fresh session opens with the same picks.
    providerId = $state(PROVIDERS[0].id);
    modelId = $state(defaultModel.id);
    temperature = $state<number>(defaultModel.params.defaultTemperature ?? 1);
    maxTokens = $state(defaultModel.params.defaultMaxTokens);
    thinkingLevel = $state<string>(
        defaultModel.params.thinking?.defaultLevel ?? 'none'
    );
    adaptiveThinking = $state<boolean>(
        defaultModel.params.thinking?.adaptive !== undefined
    );
    webSearch = $state(false);
    systemPrompt = $state('');

    settingsLoaded = $state(false);
    // appLifecycle pauses persistence while in demo mode so demo edits don't
    // overwrite real saved settings.
    paused = $state(false);

    constructor() {
        $effect.root(() => {
            $effect(() => {
                document.documentElement.dataset.theme = this.theme;
                localStorage.setItem('courierai-theme', this.theme);
            });
            $effect(() => {
                document.documentElement.style.fontSize = `${FONT_SIZES[this.fontSizeIndex]}px`;
            });

            // Immediate save for discrete controls.
            $effect(() => {
                const snapshot: Partial<UserSettings> = {
                    theme: this.theme,
                    smoothTextMode: this.smoothTextMode,
                    submitKeystroke: this.submitKeystroke,
                    modelTier: this.modelTier,
                    autoscroll: this.autoscroll,
                    enableWebSearch: this.enableWebSearch,
                    providerId: this.providerId,
                    modelId: this.modelId,
                    adaptiveThinking: this.adaptiveThinking,
                    webSearch: this.webSearch,
                    tagOpenRouterRequests: this.tagOpenRouterRequests,
                    syncApiKeys: this.syncApiKeys,
                };
                if (!this.shouldSave()) return;
                console.log(LOG, 'settings save', snapshot);
                saveToExt(snapshot);
            });

            // Debounced save for range-backed controls.
            $effect(() => {
                const snapshot: Partial<UserSettings> = {
                    fontSizeIndex: this.fontSizeIndex,
                    chatWidth: this.chatWidth,
                    temperature: this.temperature,
                    maxTokens: this.maxTokens,
                    thinkingLevel: this.thinkingLevel,
                };
                if (!this.shouldSave()) return;
                const timer = setTimeout(() => {
                    console.log(
                        LOG,
                        'settings save (slider debounce)',
                        snapshot
                    );
                    saveToExt(snapshot);
                }, 300);
                return () => clearTimeout(timer);
            });
        });
    }

    private shouldSave(): boolean {
        return (
            untrack(() => this.settingsLoaded) && !untrack(() => this.paused)
        );
    }

    async load(): Promise<void> {
        let settings: Partial<UserSettings>;
        try {
            settings = await loadFromExt();
        } catch (err) {
            console.error(LOG, 'settings load failed', err);
            errorStore.setAppError(`Couldn't load settings: ${formatErr(err)}`);
            // Leave settingsLoaded=false so persist effects don't overwrite
            // real saved settings with defaults. UI works on defaults; user
            // sees the banner.
            return;
        }
        console.log(LOG, 'settings loaded', settings);

        // Mapped type forces every UserSettings field to have a setter — adding
        // a field to UserSettings without listing it here is a TS error.
        const setSetting: {
            [K in keyof UserSettings]: (v: UserSettings[K]) => void;
        } = {
            theme: (v) => {
                this.theme = v;
            },
            fontSizeIndex: (v) => {
                this.fontSizeIndex = v;
            },
            chatWidth: (v) => {
                this.chatWidth = v;
            },
            smoothTextMode: (v) => {
                this.smoothTextMode = v;
            },
            submitKeystroke: (v) => {
                this.submitKeystroke = v;
            },
            modelTier: (v) => {
                this.modelTier = v;
            },
            autoscroll: (v) => {
                this.autoscroll = v;
            },
            enableWebSearch: (v) => {
                this.enableWebSearch = v;
            },
            providerId: (v) => {
                this.providerId = v;
            },
            modelId: (v) => {
                this.modelId = v;
            },
            temperature: (v) => {
                this.temperature = v;
            },
            maxTokens: (v) => {
                this.maxTokens = v;
            },
            thinkingLevel: (v) => {
                this.thinkingLevel = v;
            },
            adaptiveThinking: (v) => {
                this.adaptiveThinking = v;
            },
            webSearch: (v) => {
                this.webSearch = v;
            },
            tagOpenRouterRequests: (v) => {
                this.tagOpenRouterRequests = v;
            },
            syncApiKeys: (v) => {
                this.syncApiKeys = v;
            },
            legalAcceptedVersion: (v) => {
                this.legalAcceptedVersion = v;
            },
        };
        for (const key of SETTINGS_KEYS) {
            const v = settings[key];
            if (v !== undefined) (setSetting[key] as (val: unknown) => void)(v);
        }
        this.settingsLoaded = true;
    }

    // Restore per-chat config when selecting/loading a chat.
    applyChatConfig(meta: {
        providerId: string;
        modelId: string;
        temperature: number;
        maxTokens: number;
        thinkingLevel: string;
        adaptiveThinking?: boolean;
        webSearch?: boolean;
        systemPrompt: string;
    }): void {
        this.providerId = meta.providerId;
        this.modelId = meta.modelId;
        this.temperature = meta.temperature;
        this.maxTokens = meta.maxTokens;
        this.thinkingLevel = meta.thinkingLevel;
        this.adaptiveThinking = meta.adaptiveThinking ?? true;
        this.webSearch = meta.webSearch ?? false;
        this.systemPrompt = meta.systemPrompt;
    }

    persistLegalVersion(version: string): void {
        this.legalAcceptedVersion = version;
        saveToExt({ legalAcceptedVersion: version });
    }
}

export const settingsStore = new SettingsStore();
