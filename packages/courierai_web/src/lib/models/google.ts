import type { ProviderOption } from './types';

// NOTE FOR LLMS: NEVER MANUALLY MODIFY IDS/NAMES, THEY ARE CORRECT
export const GOOGLE: ProviderOption = {
    id: 'google',
    name: 'Google',
    models: [
        {
            id: 'gemini-3.1-pro-preview',
            name: 'Gemini 3.1 Pro Preview',
            params: {
                contextWindow: 1048576,
                maxOutputTokens: 65536,
                defaultMaxTokens: 8192,
                temperatureMax: 2,
                defaultTemperature: 1,
                knowledgeCutoff: 'Jan 2025',
                thinking: {
                    levels: ['none', 'low', 'high'],
                    defaultLevel: 'high',
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
                knowledgeCutoff: 'Jan 2025',
                thinking: {
                    levels: ['none', 'low', 'medium', 'high'],
                    defaultLevel: 'high',
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
                    // 2.5-pro can't disable thinking (min budget 128); 'low' maps to 512
                    levels: ['low', 'medium', 'high', 'max'],
                    defaultLevel: 'medium',
                },
            },
        },
    ],
};
