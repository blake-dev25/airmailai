export const MAX_CUSTOM_MODEL_FIELD_CHARS = 128;

export interface CustomModelConfig {
    temperature: string;
    maxTokens: string;
    thinkingLevel: string;
    thinkingBudget: string;
    adaptiveThinking: boolean;
    webSearch: boolean | string;
    webFetch: boolean | string;
    codeExecution: boolean | string;
}

export function emptyCustomModelConfig(provider: string): CustomModelConfig {
    return {
        temperature: '',
        maxTokens: '',
        thinkingLevel: '',
        thinkingBudget: '',
        adaptiveThinking: false,
        webSearch: provider === 'anthropic' ? '' : false,
        webFetch: provider === 'anthropic' ? '' : false,
        codeExecution: provider === 'anthropic' ? '' : false,
    };
}

function isCustomModelString(value: unknown): boolean {
    return (
        typeof value === 'string' &&
        value.length <= MAX_CUSTOM_MODEL_FIELD_CHARS
    );
}

function isCustomModelTool(value: unknown): boolean {
    return typeof value === 'boolean' || isCustomModelString(value);
}

const FIELD_VALIDATORS: Record<
    keyof CustomModelConfig,
    (value: unknown) => boolean
> = {
    temperature: isCustomModelString,
    maxTokens: isCustomModelString,
    thinkingLevel: isCustomModelString,
    thinkingBudget: isCustomModelString,
    adaptiveThinking: (value) => typeof value === 'boolean',
    webSearch: isCustomModelTool,
    webFetch: isCustomModelTool,
    codeExecution: isCustomModelTool,
};

export function isCustomModelConfig(
    value: unknown
): value is CustomModelConfig {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    return (
        Object.keys(value).length === Object.keys(FIELD_VALIDATORS).length &&
        Object.entries(FIELD_VALIDATORS).every(
            ([key, validate]) =>
                Object.hasOwn(value, key) && validate(Reflect.get(value, key))
        )
    );
}
