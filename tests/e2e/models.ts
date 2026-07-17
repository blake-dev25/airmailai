import type { OpenRouterModel } from '../../packages/shared/src/messages';

export const DEFAULT_PROVIDER = 'anthropic';
export const DEFAULT_MODEL = 'claude-haiku-4-5';

export const PROVIDER_MODELS = {
    anthropic: {
        label: 'Anthropic',
        chat: 'claude-haiku-4-5',
        tools: 'claude-sonnet-5',
    },
    openai: {
        label: 'OpenAI',
        chat: 'gpt-5.4-mini',
        tools: 'gpt-5.5',
    },
    google: {
        label: 'Google',
        chat: 'gemini-3.5-flash',
        tools: 'gemini-3.5-flash',
    },
    openrouter: {
        label: 'OpenRouter',
        chat: '~anthropic/claude-haiku-latest',
        // *** A non-Claude model for the web-search recall step: OpenRouter can't
        // round-trip native tool results, so sources replay via our text-fold.
        // Once search is toggled off on the recall turn, Claude models (any tier)
        // disavow the re-injected URLs as "fabricated" - no tool-call evidence to
        // stand behind - and refuse. GPT copies the cited URL from context.
        // (Anthropic-native Claude is unaffected; it round-trips real web_search
        // results.)
        tools: '~openai/gpt-latest',
    },
} as const;

export type ProviderKey = keyof typeof PROVIDER_MODELS;

// *** Seeded into the ext's chrome.storage.local OpenRouter cache so app boot
// serves the catalog from cache instead of doing a live GET /models/user on
// every test (the cold-fetch path fires whenever the OR key is present and the
// cache is empty - which is every fresh test profile). Just the models the
// OpenRouter specs select, shaped like real /models/user rows so the picker
// and ModelConfig render exactly as in prod. The specs still make real
// OpenRouter chat calls; only the model-list lookup is short-circuited. These
// `id`s must stay in lockstep with PROVIDER_MODELS.openrouter's chat/tools ids
// (haiku for the multiturn specs, gpt for the server-tool flows).
export const OPENROUTER_CACHE_MODELS: OpenRouterModel[] = [
    {
        id: '~anthropic/claude-haiku-latest',
        name: 'Anthropic: Claude Haiku',
        vendor: '~anthropic',
        contextWindow: 200_000,
        maxOutputTokens: 8192,
        inputModalities: ['text', 'image'],
        supportedParams: ['tools', 'reasoning', 'temperature', 'max_tokens'],
        free: false,
        created: 1_730_000_000,
    },
    {
        id: '~openai/gpt-latest',
        name: 'OpenAI: GPT-5.5',
        vendor: '~openai',
        contextWindow: 400_000,
        maxOutputTokens: 128_000,
        inputModalities: ['text', 'image'],
        supportedParams: ['tools', 'reasoning', 'temperature', 'max_tokens'],
        free: false,
        created: 1_730_000_000,
    },
];
