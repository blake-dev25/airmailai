import type { OpenRouterModel } from '../../packages/shared/src/messages';
import {
    modelHasTier,
    PROVIDERS,
    type ModelOption,
} from '../../packages/airmailai_web/src/lib/models';

export const DEFAULT_PROVIDER = 'anthropic';

function testProviderModel(providerId: string): {
    label: string;
    model: ModelOption;
} {
    const provider = PROVIDERS.find((candidate) => candidate.id === providerId);
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);
    const models = provider.models.filter((model) =>
        modelHasTier(model.id, 'test')
    );
    if (models.length !== 1) {
        throw new Error(
            `Expected exactly one test model for ${providerId}, found ${models.length}`
        );
    }
    return { label: provider.name, model: models[0] };
}

const ANTHROPIC_TEST = testProviderModel('anthropic');
const OPENAI_TEST = testProviderModel('openai');
const GOOGLE_TEST = testProviderModel('google');

export const DEFAULT_MODEL = ANTHROPIC_TEST.model.id;
export const DEFAULT_MODEL_PARAMS = ANTHROPIC_TEST.model.params;

export const PROVIDER_MODELS = {
    anthropic: {
        label: ANTHROPIC_TEST.label,
        chat: ANTHROPIC_TEST.model.id,
        chatName: ANTHROPIC_TEST.model.name,
        tools: ANTHROPIC_TEST.model.id,
        toolsName: ANTHROPIC_TEST.model.name,
    },
    openai: {
        label: OPENAI_TEST.label,
        chat: OPENAI_TEST.model.id,
        chatName: OPENAI_TEST.model.name,
        tools: OPENAI_TEST.model.id,
        toolsName: OPENAI_TEST.model.name,
    },
    google: {
        label: GOOGLE_TEST.label,
        chat: GOOGLE_TEST.model.id,
        chatName: GOOGLE_TEST.model.name,
        tools: GOOGLE_TEST.model.id,
        toolsName: GOOGLE_TEST.model.name,
    },
    openrouter: {
        label: 'OpenRouter',
        chat: '~anthropic/claude-haiku-latest',
        chatName: 'Anthropic: Claude Haiku',
        // *** A non-Claude model for the web-search recall step: OpenRouter can't
        // round-trip native tool results, so sources replay via our text-fold.
        // Once search is toggled off on the recall turn, Claude models (any tier)
        // disavow the re-injected URLs as "fabricated" - no tool-call evidence to
        // stand behind - and refuse. GPT copies the cited URL from context.
        // (Anthropic-native Claude is unaffected; it round-trips real web_search
        // results.)
        tools: '~openai/gpt-latest',
        toolsName: 'OpenAI: GPT-Latest',
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
        supportedParams: ['tools', 'reasoning', 'max_tokens'],
        free: false,
        created: 1_730_000_000,
    },
    {
        id: '~openai/gpt-latest',
        name: 'OpenAI: GPT-Latest',
        vendor: '~openai',
        contextWindow: 400_000,
        maxOutputTokens: 128_000,
        inputModalities: ['text', 'image'],
        supportedParams: ['tools', 'reasoning', 'max_tokens'],
        free: false,
        created: 1_730_000_000,
    },
];
