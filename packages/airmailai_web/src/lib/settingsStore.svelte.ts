import {
    SETTINGS_KEYS,
    type BrandingMode,
    type UserSettings,
} from '@airmailai/shared';
import { untrack } from 'svelte';
import {
    defaultModelForProvider,
    FONT_SIZES,
    type ModelTier,
    PROVIDERS,
    THEMES,
} from './constants';
import type { ModelOption } from './models';
import { reportAppError } from './errorStore.svelte';
import {
    loadSettings as loadFromExt,
    saveSettings as saveToExtRaw,
} from './extension';

import { log } from './log';

function saveToExt(snapshot: Partial<UserSettings>): void {
    saveToExtRaw(snapshot).catch((err) => {
        reportAppError('settings save failed', "Couldn't save settings", err);
    });
}

function setSettingValue<K extends keyof UserSettings>(
    target: Partial<UserSettings>,
    key: K,
    value: Partial<UserSettings>[K]
): void {
    target[key] = value;
}

function getDefaultFontSizeIndex(): number {
    const w = window.screen.width;
    if (w <= 1366) return 1;
    return 2;
}

function getInitialBrandingMode(): BrandingMode {
    const stored = localStorage.getItem('airmailai-show-branding');
    if (stored === 'stripes' || stored === 'off') return stored;
    return 'on';
}

const SAVE_DEBOUNCE_MS = 300;

const defaultModel =
    defaultModelForProvider(PROVIDERS[0]) ?? PROVIDERS[0].models[0];

const isBool = (v: unknown) => typeof v === 'boolean';
const isString = (v: unknown) => typeof v === 'string';
const isIntInRange = (min: number, max: number) => (v: unknown) =>
    typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const isNumInRange = (min: number, max: number) => (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const isOneOf =
    (...options: string[]) =>
    (v: unknown) =>
        typeof v === 'string' && options.includes(v);

const SETTING_VALIDATORS: {
    [K in keyof UserSettings]: (v: unknown) => boolean;
} = {
    theme: (v) => typeof v === 'string' && THEMES.some((t) => t.id === v),
    fontSizeIndex: isIntInRange(0, FONT_SIZES.length - 1),
    chatWidth: isNumInRange(0, 100),
    smoothTextMode: isOneOf('smooth', 'raw'),
    submitKeystroke: isOneOf('enter', 'ctrl+enter'),
    modelTier: isOneOf('latest', 'previous', 'legacy', 'test'),
    autoscrollMode: isOneOf('pin-user-message', 'pin-bottom', 'off'),
    chatSortOrder: isOneOf('modified', 'created'),
    enableWebSearch: isBool,
    enableWebFetch: isBool,
    enableCodeExecution: isBool,
    enableFileUploads: isBool,
    enableProviderFileStorage: isBool,
    providerId: (v) =>
        typeof v === 'string' && PROVIDERS.some((p) => p.id === v),
    modelId: isString,
    temperature: isNumInRange(0, 2),
    maxTokens: isIntInRange(1, 1_000_000),
    thinkingLevel: isString,
    adaptiveThinking: isBool,
    tagOpenRouterRequests: isBool,
    openRouterPdfEngine: isOneOf(
        'native',
        'auto',
        'cloudflare-ai',
        'mistral-ocr'
    ),
    brandingMode: isOneOf('on', 'stripes', 'off'),
    messageFont: isOneOf('serif', 'sans'),
    legalAcceptedVersion: isString,
};

class SettingsStore implements UserSettings {
    theme = $state('airmail-warm');
    fontSizeIndex = $state(getDefaultFontSizeIndex());
    chatWidth = $state(0);
    smoothTextMode = $state<'smooth' | 'raw'>('smooth');
    submitKeystroke = $state<'enter' | 'ctrl+enter'>('enter');
    modelTier = $state<ModelTier>('latest');
    autoscrollMode = $state<'pin-user-message' | 'pin-bottom' | 'off'>(
        'pin-user-message'
    );
    chatSortOrder = $state<'modified' | 'created'>('modified');
    enableWebSearch = $state(false);
    enableWebFetch = $state(false);
    enableCodeExecution = $state(false);
    enableFileUploads = $state(false);
    enableProviderFileStorage = $state(false);
    tagOpenRouterRequests = $state(false);
    openRouterPdfEngine = $state<
        'native' | 'auto' | 'cloudflare-ai' | 'mistral-ocr'
    >('native');
    brandingMode = $state<BrandingMode>(getInitialBrandingMode());
    messageFont = $state<'serif' | 'sans'>(
        localStorage.getItem('airmailai-message-font') === 'sans'
            ? 'sans'
            : 'serif'
    );
    legalAcceptedVersion = $state('');
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
    webFetch = $state(false);
    codeExecution = $state(false);
    systemPrompt = $state('');
    settingsLoaded = $state(false);
    paused = $state(false);
    private lastSaved: Partial<UserSettings> = {};
    private pendingSave: Partial<UserSettings> | null = null;
    private pendingSaveTimer: ReturnType<typeof setTimeout> | null = null;

    private saveChanged(snapshot: Partial<UserSettings>): void {
        const changed: Partial<UserSettings> = {};
        for (const key of Object.keys(snapshot) as (keyof UserSettings)[]) {
            if (this.lastSaved[key] !== snapshot[key]) {
                setSettingValue(changed, key, snapshot[key]);
            }
        }
        if (Object.keys(changed).length === 0) return;
        Object.assign(this.lastSaved, changed);
        log.info('settings save', changed);
        saveToExt(changed);
    }

    private queueSave(snapshot: Partial<UserSettings>): void {
        this.pendingSave = { ...(this.pendingSave ?? {}), ...snapshot };
        if (this.pendingSaveTimer !== null) clearTimeout(this.pendingSaveTimer);
        this.pendingSaveTimer = setTimeout(
            () => this.flushPendingSave(),
            SAVE_DEBOUNCE_MS
        );
    }

    private flushPendingSave(): void {
        if (this.pendingSaveTimer !== null) {
            clearTimeout(this.pendingSaveTimer);
            this.pendingSaveTimer = null;
        }
        const pending = this.pendingSave;
        this.pendingSave = null;
        if (pending) this.saveChanged(pending);
    }

    constructor() {
        window.addEventListener('pagehide', () => this.flushPendingSave());
        $effect.root(() => {
            $effect(() => {
                document.documentElement.dataset.theme = this.theme;
                localStorage.setItem('airmailai-theme', this.theme);
            });
            $effect(() => {
                localStorage.setItem(
                    'airmailai-show-branding',
                    this.brandingMode
                );
            });
            $effect(() => {
                document.documentElement.dataset.messageFont = this.messageFont;
                localStorage.setItem(
                    'airmailai-message-font',
                    this.messageFont
                );
            });
            $effect(() => {
                document.documentElement.style.fontSize = `${FONT_SIZES[this.fontSizeIndex]}px`;
            });

            $effect(() => {
                const snapshot: Partial<UserSettings> = {};
                for (const key of SETTINGS_KEYS) {
                    if (key === 'legalAcceptedVersion') continue;
                    setSettingValue(snapshot, key, this[key]);
                }
                if (!this.shouldSave()) return;
                this.queueSave(snapshot);
            });
        });
    }

    private shouldSave(): boolean {
        return (
            untrack(() => this.settingsLoaded) && !untrack(() => this.paused)
        );
    }

    async load(): Promise<void> {
        let settings: Partial<UserSettings> | null = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                settings = await loadFromExt();
                break;
            } catch (err) {
                if (attempt === 3) {
                    reportAppError(
                        'settings load failed after 3 attempts',
                        "Couldn't load settings",
                        err
                    );
                    return;
                }
                log.warn(`settings load attempt ${attempt} failed`, err);
                await new Promise((r) => setTimeout(r, 300 * attempt));
            }
        }
        if (settings === null) return;
        log.info('settings loaded', settings);

        for (const key of SETTINGS_KEYS) {
            const v = settings[key];
            if (v === undefined) continue;
            if (!SETTING_VALIDATORS[key](v)) {
                log.warn('ignoring invalid stored setting', key, v);
                continue;
            }
            setSettingValue(this, key, v);
            setSettingValue(this.lastSaved, key, v);
        }
        this.settingsLoaded = true;
    }

    applyChatConfig(meta: {
        providerId: string;
        modelId: string;
        temperature: number;
        maxTokens: number;
        thinkingLevel: string;
        adaptiveThinking?: boolean;
        webSearch?: boolean;
        webFetch?: boolean;
        codeExecution?: boolean;
        systemPrompt: string;
    }): void {
        this.providerId = meta.providerId;
        this.modelId = meta.modelId;
        this.temperature = meta.temperature;
        this.maxTokens = meta.maxTokens;
        this.thinkingLevel = meta.thinkingLevel;
        this.adaptiveThinking = meta.adaptiveThinking ?? true;
        this.webSearch = meta.webSearch ?? false;
        this.webFetch = meta.webFetch ?? false;
        this.codeExecution = meta.codeExecution ?? false;
        this.systemPrompt = meta.systemPrompt;
    }

    snapshotChatConfig(): {
        systemPrompt: string;
        providerId: string;
        modelId: string;
        temperature: number;
        maxTokens: number;
        thinkingLevel: string;
        adaptiveThinking: boolean;
        webSearch: boolean;
        webFetch: boolean;
        codeExecution: boolean;
    } {
        return {
            systemPrompt: this.systemPrompt,
            providerId: this.providerId,
            modelId: this.modelId,
            temperature: this.temperature,
            maxTokens: this.maxTokens,
            thinkingLevel: this.thinkingLevel,
            adaptiveThinking: this.adaptiveThinking,
            webSearch: this.webSearch,
            webFetch: this.webFetch,
            codeExecution: this.codeExecution,
        };
    }

    applyToolDefaults(model: ModelOption | null): void {
        this.webSearch = this.enableWebSearch && !!model?.tools?.webSearch;
        this.webFetch = this.enableWebFetch && !!model?.tools?.webFetch;
        this.codeExecution =
            this.enableCodeExecution && !!model?.tools?.codeExecution;
    }

    persistLegalVersion(version: string): void {
        this.legalAcceptedVersion = version;
        this.flushPendingSave();
        this.saveChanged({ legalAcceptedVersion: version });
    }

    setFileUploadsEnabled(on: boolean): void {
        this.enableFileUploads = on;
        this.enableProviderFileStorage = on;
        if (on) this.enableCodeExecution = true;
    }
}

export const settingsStore = new SettingsStore();
