import type {
    FirstPartyProviderId,
    ModelOption,
    ModelParams,
    ModelTools,
    ModelsFile,
    ThinkingLevel,
    ToolSupport,
} from './types';

export const MODELS_FILE_PATH = '/models.json';
export const MODELS_FILE_SCHEMA_VERSION = 1;
export const FIRST_PARTY_PROVIDER_IDS: readonly FirstPartyProviderId[] = [
    'anthropic',
    'openai',
    'google',
];

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
];

export const SAFE_MODEL_ID = /^[A-Za-z0-9._:/~-]+$/;

function fail(path: string, problem: string): never {
    throw new Error(`models.json: ${path} ${problem}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
    if (!isRecord(value)) fail(path, 'must be an object');
    return value;
}

function requireString(value: unknown, path: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        fail(path, 'must be a non-empty string');
    }
    return value;
}

function requireNonNegativeInt(value: unknown, path: string): number {
    if (!Number.isInteger(value) || (value as number) < 0) {
        fail(path, 'must be a non-negative integer');
    }
    return value as number;
}

function requireFiniteNumber(value: unknown, path: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        fail(path, 'must be a finite number');
    }
    return value;
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
    return THINKING_LEVELS.includes(value as ThinkingLevel);
}

function parseThinking(
    value: unknown,
    path: string
): NonNullable<ModelParams['thinking']> {
    const raw = requireRecord(value, path);
    if (!Array.isArray(raw.levels) || raw.levels.length === 0) {
        fail(`${path}.levels`, 'must be a non-empty array');
    }
    const levels: ThinkingLevel[] = raw.levels.map((level, i) => {
        if (!isThinkingLevel(level)) {
            fail(`${path}.levels[${i}]`, 'is not a thinking level');
        }
        return level;
    });
    if (!isThinkingLevel(raw.defaultLevel)) {
        fail(`${path}.defaultLevel`, 'is not a thinking level');
    }
    if (!levels.includes(raw.defaultLevel)) {
        fail(`${path}.defaultLevel`, 'is not one of levels');
    }
    const thinking: NonNullable<ModelParams['thinking']> = {
        levels,
        defaultLevel: raw.defaultLevel,
    };
    if (raw.adaptive !== undefined) {
        if (raw.adaptive !== 'optional' && raw.adaptive !== 'required') {
            fail(`${path}.adaptive`, "must be 'optional' or 'required'");
        }
        thinking.adaptive = raw.adaptive;
    }
    return thinking;
}

function parseParams(value: unknown, path: string): ModelParams {
    const raw = requireRecord(value, path);
    const params: ModelParams = {
        contextWindow: requireNonNegativeInt(
            raw.contextWindow,
            `${path}.contextWindow`
        ),
        maxOutputTokens: requireNonNegativeInt(
            raw.maxOutputTokens,
            `${path}.maxOutputTokens`
        ),
        defaultMaxTokens: requireNonNegativeInt(
            raw.defaultMaxTokens,
            `${path}.defaultMaxTokens`
        ),
    };
    if (raw.temperatureMax !== undefined) {
        params.temperatureMax = requireFiniteNumber(
            raw.temperatureMax,
            `${path}.temperatureMax`
        );
    }
    if (raw.defaultTemperature !== undefined) {
        params.defaultTemperature = requireFiniteNumber(
            raw.defaultTemperature,
            `${path}.defaultTemperature`
        );
    }
    if (raw.knowledgeCutoff !== undefined) {
        params.knowledgeCutoff = requireString(
            raw.knowledgeCutoff,
            `${path}.knowledgeCutoff`
        );
    }
    if (raw.thinking !== undefined) {
        params.thinking = parseThinking(raw.thinking, `${path}.thinking`);
    }
    return params;
}

function parseToolSupport(value: unknown, path: string): ToolSupport {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string' && value.length > 0) return value;
    fail(path, 'must be a boolean or non-empty string');
}

function parseTools(value: unknown, path: string): ModelTools {
    const raw = requireRecord(value, path);
    const tools: ModelTools = {};
    for (const key of ['webSearch', 'webFetch', 'codeExecution'] as const) {
        if (raw[key] !== undefined) {
            tools[key] = parseToolSupport(raw[key], `${path}.${key}`);
        }
    }
    if (raw.searchFetchLinked !== undefined) {
        if (typeof raw.searchFetchLinked !== 'boolean') {
            fail(`${path}.searchFetchLinked`, 'must be a boolean');
        }
        tools.searchFetchLinked = raw.searchFetchLinked;
    }
    return tools;
}

function parseModel(value: unknown, path: string): ModelOption {
    const raw = requireRecord(value, path);
    const id = requireString(raw.id, `${path}.id`);
    if (!SAFE_MODEL_ID.test(id))
        fail(`${path}.id`, 'contains unsafe characters');
    const model: ModelOption = {
        id,
        name: requireString(raw.name, `${path}.name`),
        params: parseParams(raw.params, `${path}.params`),
    };
    if (raw.tools !== undefined) {
        model.tools = parseTools(raw.tools, `${path}.tools`);
    }
    return model;
}

function parseModelList(value: unknown, path: string): ModelOption[] {
    if (!Array.isArray(value)) fail(path, 'must be an array');
    const seen = new Set<string>();
    return value.map((entry, i) => {
        const model = parseModel(entry, `${path}[${i}]`);
        if (seen.has(model.id)) fail(`${path}[${i}].id`, 'is a duplicate');
        seen.add(model.id);
        return model;
    });
}

export function parseModelsFile(raw: unknown): ModelsFile {
    const root = requireRecord(raw, 'root');
    if (root.schemaVersion !== MODELS_FILE_SCHEMA_VERSION) {
        fail(
            'schemaVersion',
            `must be ${MODELS_FILE_SCHEMA_VERSION} (got ${String(root.schemaVersion)})`
        );
    }
    const generatedAt = requireString(root.generatedAt, 'generatedAt');
    if (Number.isNaN(Date.parse(generatedAt))) {
        fail('generatedAt', 'is not a parseable date');
    }
    const providersRaw = requireRecord(root.providers, 'providers');
    const providers = {} as ModelsFile['providers'];
    for (const id of FIRST_PARTY_PROVIDER_IDS) {
        providers[id] = parseModelList(providersRaw[id], `providers.${id}`);
    }
    return {
        schemaVersion: MODELS_FILE_SCHEMA_VERSION,
        generatedAt,
        providers,
    };
}
