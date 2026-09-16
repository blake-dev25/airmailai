import {
    validateCustomModelConfig,
    validateModelIdLength,
} from './settingsValidation';

export function validateModelRequest(
    provider: string,
    model: string,
    customModel: unknown
): void {
    validateModelIdLength(model);
    if (customModel != null) validateCustomModelConfig(customModel);
    if (provider !== 'google') return;
    const name = model.replace(/^(?:models|tunedModels)\//, '');
    if (
        !name ||
        /[^a-zA-Z0-9._~-]/.test(name) ||
        name === '.' ||
        name === '..'
    ) {
        throw new Error(
            'Google model IDs must use letters, numbers, dots, underscores, hyphens, or tildes, optionally prefixed with "models/" or "tunedModels/".'
        );
    }
}
