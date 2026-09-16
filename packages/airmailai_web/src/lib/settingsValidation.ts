import {
    isCustomModelConfig,
    MAX_CUSTOM_MODEL_FIELD_CHARS,
    type CustomModelConfig,
    type UserSettings,
} from '@airmailai/shared';

export const MAX_MODEL_ID_CHARS = 256;
export const MAX_SETTING_STRING_CHARS = 128;
const MAX_SYNC_ITEM_BYTES = 8192;
const encoder = new TextEncoder();

export function validateCustomModelConfig(
    value: unknown
): asserts value is CustomModelConfig {
    if (!isCustomModelConfig(value)) {
        throw new Error(
            `Custom model configuration has invalid or unknown fields. Text fields must be at most ${MAX_CUSTOM_MODEL_FIELD_CHARS} characters.`
        );
    }
}

export function validateModelIdLength(model: string): void {
    if (model.length > MAX_MODEL_ID_CHARS) {
        throw new Error(
            `Model ID must be at most ${MAX_MODEL_ID_CHARS} characters.`
        );
    }
}

export function validateSettingsForStorage(
    settings: Partial<UserSettings>
): void {
    for (const [key, value] of Object.entries(settings)) {
        const serialized = JSON.stringify(value);
        if (
            serialized === undefined ||
            encoder.encode(key + serialized).byteLength > MAX_SYNC_ITEM_BYTES
        ) {
            throw new Error(
                `Setting "${key}" exceeds the ${MAX_SYNC_ITEM_BYTES}-byte storage limit.`
            );
        }
        if (key === 'customModel' && value !== null) {
            validateCustomModelConfig(value);
        } else if (typeof value === 'string') {
            const limit =
                key === 'modelId'
                    ? MAX_MODEL_ID_CHARS
                    : MAX_SETTING_STRING_CHARS;
            if (value.length > limit) {
                throw new Error(
                    `Setting "${key}" must be at most ${limit} characters.`
                );
            }
        }
    }
}
