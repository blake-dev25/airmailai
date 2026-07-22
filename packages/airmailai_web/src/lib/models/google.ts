import type { ProviderOption } from './types';

// NOTE FOR LLMS: NEVER MANUALLY MODIFY IDS/NAMES, THEY ARE CORRECT
// This file is automatically written over by scripts/update-model-list.ts, edits will not be saved
export const GOOGLE: ProviderOption = {
    id: 'google',
    name: 'Google',
    models: [
        {
            id: 'gemini-2.5-flash',
            name: 'Gemini 2.5 Flash',
            params: {
                contextWindow: 1048576,
                maxOutputTokens: 65536,
                defaultMaxTokens: 8192,
                temperatureMax: 2,
                defaultTemperature: 1,
                knowledgeCutoff: 'Jan 2025',
                thinking: {
                    levels: ['none', 'low', 'medium', 'high', 'max'],
                    defaultLevel: 'medium',
                    adaptive: 'optional',
                },
            },
        },
        {
            id: 'gemini-2.5-pro',
            name: 'Gemini 2.5 Pro',
            params: {
                contextWindow: 1048576,
                maxOutputTokens: 65536,
                defaultMaxTokens: 8192,
                temperatureMax: 2,
                defaultTemperature: 1,
                knowledgeCutoff: 'Jan 2025',
                thinking: {
                    levels: ['low', 'medium', 'high', 'max'],
                    defaultLevel: 'medium',
                    adaptive: 'optional',
                },
            },
        },
        {
            id: 'gemini-2.5-flash-lite',
            name: 'Gemini 2.5 Flash-Lite',
            params: {
                contextWindow: 1048576,
                maxOutputTokens: 65536,
                defaultMaxTokens: 8192,
                temperatureMax: 2,
                defaultTemperature: 1,
                knowledgeCutoff: 'Jan 2025',
                thinking: {
                    levels: ['none', 'low', 'medium', 'high', 'max'],
                    defaultLevel: 'none',
                    adaptive: 'optional',
                },
            },
        },
        {
            id: 'gemini-3-flash-preview',
            name: 'Gemini 3 Flash Preview',
            params: {
                contextWindow: 1048576,
                maxOutputTokens: 65536,
                defaultMaxTokens: 8192,
                temperatureMax: 2,
                defaultTemperature: 1,
                thinking: {
                    levels: ['minimal', 'low', 'medium', 'high'],
                    defaultLevel: 'high',
                },
            },
        },
        {
            id: 'gemini-3.1-pro-preview',
            name: 'Gemini 3.1 Pro Preview',
            params: {
                contextWindow: 1048576,
                maxOutputTokens: 65536,
                defaultMaxTokens: 8192,
                temperatureMax: 2,
                defaultTemperature: 1,
                thinking: {
                    levels: ['low', 'medium', 'high'],
                    defaultLevel: 'high',
                },
            },
        },
        {
            id: 'gemini-3.1-flash-lite-preview',
            name: 'Gemini 3.1 Flash Lite Preview',
            params: {
                contextWindow: 1048576,
                maxOutputTokens: 65536,
                defaultMaxTokens: 8192,
                temperatureMax: 2,
                defaultTemperature: 1,
                thinking: {
                    levels: ['minimal', 'low', 'medium', 'high'],
                    defaultLevel: 'minimal',
                },
            },
        },
        {
            id: 'gemini-3.1-flash-lite',
            name: 'Gemini 3.1 Flash Lite',
            params: {
                contextWindow: 1048576,
                maxOutputTokens: 65536,
                defaultMaxTokens: 8192,
                temperatureMax: 2,
                defaultTemperature: 1,
                thinking: {
                    levels: ['minimal', 'low', 'medium', 'high'],
                    defaultLevel: 'minimal',
                },
            },
        },
        {
            id: 'gemini-3.5-flash',
            name: 'Gemini 3.5 Flash',
            params: {
                contextWindow: 1048576,
                maxOutputTokens: 65536,
                defaultMaxTokens: 8192,
                temperatureMax: 2,
                defaultTemperature: 1,
                knowledgeCutoff: 'Jan 2025',
                thinking: {
                    levels: ['minimal', 'low', 'medium', 'high'],
                    defaultLevel: 'medium',
                },
            },
        },
        {
            id: 'gemini-3.5-flash-lite',
            name: 'Gemini 3.5 Flash Lite',
            params: {
                contextWindow: 1048576,
                maxOutputTokens: 65536,
                defaultMaxTokens: 8192,
                temperatureMax: 2,
                defaultTemperature: 1,
                thinking: {
                    levels: ['minimal', 'low', 'medium', 'high'],
                    defaultLevel: 'minimal',
                },
            },
        },
        {
            id: 'gemini-3.6-flash',
            name: 'Gemini 3.6 Flash',
            params: {
                contextWindow: 1048576,
                maxOutputTokens: 65536,
                defaultMaxTokens: 8192,
                temperatureMax: 2,
                defaultTemperature: 1,
                thinking: {
                    levels: ['minimal', 'low', 'medium', 'high'],
                    defaultLevel: 'medium',
                },
            },
        },
        {
            id: 'gemini-robotics-er-1.6-preview',
            name: 'Gemini Robotics-ER 1.6 Preview',
            params: {
                contextWindow: 131072,
                maxOutputTokens: 65536,
                defaultMaxTokens: 8192,
                temperatureMax: 2,
                defaultTemperature: 1,
                knowledgeCutoff: 'Jan 2025',
                thinking: {
                    levels: ['none', 'low', 'high'],
                    defaultLevel: 'none',
                },
            },
        },
        {
            id: 'gemini-2.5-computer-use-preview-10-2025',
            name: 'Gemini 2.5 Computer Use Preview 10-2025',
            params: {
                contextWindow: 131072,
                maxOutputTokens: 65536,
                defaultMaxTokens: 8192,
                temperatureMax: 2,
                defaultTemperature: 1,
            },
        },
        {
            id: 'antigravity-preview-05-2026',
            name: 'Antigravity Agent Preview',
            params: {
                contextWindow: 131072,
                maxOutputTokens: 65536,
                defaultMaxTokens: 8192,
            },
        },
        {
            id: 'deep-research-max-preview-04-2026',
            name: 'Deep Research Max Preview (Apr-21-2026)',
            params: {
                contextWindow: 131072,
                maxOutputTokens: 65536,
                defaultMaxTokens: 8192,
                temperatureMax: 2,
                defaultTemperature: 1,
            },
        },
        {
            id: 'deep-research-preview-04-2026',
            name: 'Deep Research Preview (Apr-21-2026)',
            params: {
                contextWindow: 131072,
                maxOutputTokens: 65536,
                defaultMaxTokens: 8192,
                temperatureMax: 2,
                defaultTemperature: 1,
            },
        },
        {
            id: 'deep-research-pro-preview-12-2025',
            name: 'Deep Research Pro Preview (Dec-12-2025)',
            params: {
                contextWindow: 131072,
                maxOutputTokens: 65536,
                defaultMaxTokens: 8192,
                temperatureMax: 2,
                defaultTemperature: 1,
            },
        },
    ],
};
