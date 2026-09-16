import type { CustomModelConfig, ProviderStreamArgs } from '@airmailai/shared';
import { makeDebugFetch } from './debug-fetch';

function numericValue(value: string): number | string | undefined {
    if (!value.trim()) return undefined;
    const number = Number(value);
    return Number.isFinite(number) ? number : value;
}

function textValue(value: string): string | undefined {
    return value.trim() ? value : undefined;
}

export function customModelParameters(
    provider: string,
    config: CustomModelConfig
): Record<string, unknown> {
    const temperature = numericValue(config.temperature);
    const maxTokens = numericValue(config.maxTokens);
    const thinkingLevel = textValue(config.thinkingLevel);
    const thinkingBudget = numericValue(config.thinkingBudget);
    const parameters: Record<string, unknown> = {};
    if (temperature !== undefined) parameters.temperature = temperature;
    if (maxTokens !== undefined) {
        parameters[
            provider === 'anthropic'
                ? 'max_tokens'
                : provider === 'google'
                  ? 'maxOutputTokens'
                  : 'max_output_tokens'
        ] = maxTokens;
    }
    if (provider === 'anthropic') {
        if (config.adaptiveThinking) {
            parameters.thinking = { type: 'adaptive' };
            if (thinkingLevel !== undefined)
                parameters.output_config = { effort: thinkingLevel };
        } else if (thinkingBudget !== undefined) {
            parameters.thinking = {
                type: 'enabled',
                budget_tokens: thinkingBudget,
            };
        }
    } else if (provider === 'google') {
        if (thinkingLevel !== undefined || thinkingBudget !== undefined) {
            parameters.thinkingConfig = {
                ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
                ...(thinkingBudget !== undefined ? { thinkingBudget } : {}),
                includeThoughts: true,
            };
        }
    } else if (thinkingLevel !== undefined) {
        parameters.reasoning = { effort: thinkingLevel, summary: 'auto' };
    }
    return parameters;
}

export function getCustomModel(
    args: ProviderStreamArgs
): CustomModelConfig | undefined {
    return args.params.customModel as CustomModelConfig | undefined;
}

export function makeModelFetch(
    provider: 'anthropic' | 'openai' | 'openrouter',
    args: ProviderStreamArgs
):
    | ((...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>)
    | undefined {
    const fetcher = makeDebugFetch(provider);
    const config = getCustomModel(args);
    if (!config) return fetcher;
    const send = fetcher ?? fetch;
    const endpoint = provider === 'anthropic' ? '/messages' : '/responses';
    return async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        const method =
            init?.method ?? (input instanceof Request ? input.method : 'GET');
        if (
            method.toUpperCase() !== 'POST' ||
            !new URL(url).pathname.endsWith(endpoint)
        ) {
            return send(input, init);
        }
        const raw =
            typeof init?.body === 'string'
                ? init.body
                : input instanceof Request
                  ? await input.clone().text()
                  : '';
        const body: Record<string, unknown> = JSON.parse(raw);
        for (const key of [
            'model',
            'temperature',
            'max_tokens',
            'max_output_tokens',
            'reasoning',
            'thinking',
            'output_config',
        ]) {
            delete body[key];
        }
        if (args.model.trim()) body.model = args.model;
        Object.assign(body, customModelParameters(provider, config));
        const updated = { ...init, body: JSON.stringify(body) };
        return input instanceof Request
            ? send(new Request(input, updated))
            : send(input, updated);
    };
}
