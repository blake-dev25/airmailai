import type { ProviderOption } from './types';

// NOTE FOR LLMS: NEVER MANUALLY MODIFY IDS/NAMES, THEY ARE CORRECT
// This file is automatically written over by scripts/update-model-list.ts, edits will not be saved
export const ANTHROPIC: ProviderOption = {
    id: 'anthropic',
    name: 'Anthropic',
    models: [
        {
            id: 'claude-sonnet-5',
            name: 'Claude Sonnet 5',
            params: {
                contextWindow: 1000000,
                maxOutputTokens: 128000,
                defaultMaxTokens: 8192,
                knowledgeCutoff: 'Jan 2026',
                thinking: {
                    levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
                    defaultLevel: 'high',
                    adaptive: 'required',
                },
            },
            tools: {
                webSearch: 'web_search_20260209',
                webFetch: 'web_fetch_20260209',
                codeExecution: 'code_execution_20260120',
            },
        },
        {
            id: 'claude-fable-5',
            name: 'Claude Fable 5',
            params: {
                contextWindow: 1000000,
                maxOutputTokens: 128000,
                defaultMaxTokens: 8192,
                knowledgeCutoff: 'Jan 2026',
                thinking: {
                    levels: ['low', 'medium', 'high', 'xhigh', 'max'],
                    defaultLevel: 'high',
                    adaptive: 'required',
                },
            },
            tools: {
                webSearch: 'web_search_20260209',
                webFetch: 'web_fetch_20260209',
                codeExecution: 'code_execution_20260120',
            },
        },
        {
            id: 'claude-opus-4-8',
            name: 'Claude Opus 4.8',
            params: {
                contextWindow: 1000000,
                maxOutputTokens: 128000,
                defaultMaxTokens: 8192,
                knowledgeCutoff: 'Jan 2026',
                thinking: {
                    levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
                    defaultLevel: 'high',
                    adaptive: 'required',
                },
            },
            tools: {
                webSearch: 'web_search_20260209',
                webFetch: 'web_fetch_20260209',
                codeExecution: 'code_execution_20260120',
            },
        },
        {
            id: 'claude-opus-4-7',
            name: 'Claude Opus 4.7',
            params: {
                contextWindow: 1000000,
                maxOutputTokens: 128000,
                defaultMaxTokens: 8192,
                knowledgeCutoff: 'Jan 2026',
                thinking: {
                    levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
                    defaultLevel: 'high',
                    adaptive: 'required',
                },
            },
            tools: {
                webSearch: 'web_search_20260209',
                webFetch: 'web_fetch_20260209',
                codeExecution: 'code_execution_20260120',
            },
        },
        {
            id: 'claude-sonnet-4-6',
            name: 'Claude Sonnet 4.6',
            params: {
                contextWindow: 1000000,
                maxOutputTokens: 128000,
                defaultMaxTokens: 8192,
                temperatureMax: 1,
                defaultTemperature: 1,
                knowledgeCutoff: 'Aug 2025',
                thinking: {
                    levels: ['none', 'low', 'medium', 'high', 'max'],
                    defaultLevel: 'high',
                    adaptive: 'optional',
                },
            },
            tools: {
                webSearch: 'web_search_20260209',
                webFetch: 'web_fetch_20260209',
                codeExecution: 'code_execution_20260120',
            },
        },
        {
            id: 'claude-opus-4-6',
            name: 'Claude Opus 4.6',
            params: {
                contextWindow: 1000000,
                maxOutputTokens: 128000,
                defaultMaxTokens: 8192,
                temperatureMax: 1,
                defaultTemperature: 1,
                knowledgeCutoff: 'May 2025',
                thinking: {
                    levels: ['none', 'low', 'medium', 'high', 'max'],
                    defaultLevel: 'high',
                    adaptive: 'optional',
                },
            },
            tools: {
                webSearch: 'web_search_20260209',
                webFetch: 'web_fetch_20260209',
                codeExecution: 'code_execution_20260120',
            },
        },
        {
            id: 'claude-opus-4-5-20251101',
            name: 'Claude Opus 4.5',
            params: {
                contextWindow: 200000,
                maxOutputTokens: 64000,
                defaultMaxTokens: 8192,
                temperatureMax: 1,
                defaultTemperature: 1,
                knowledgeCutoff: 'May 2025',
                thinking: {
                    levels: ['none', 'low', 'medium', 'high'],
                    defaultLevel: 'high',
                },
            },
            tools: {
                webSearch: 'web_search_20250305',
                webFetch: 'web_fetch_20250910',
                codeExecution: 'code_execution_20260120',
            },
        },
        {
            id: 'claude-haiku-4-5',
            name: 'Claude Haiku 4.5',
            params: {
                contextWindow: 200000,
                maxOutputTokens: 64000,
                defaultMaxTokens: 8192,
                temperatureMax: 1,
                defaultTemperature: 1,
                knowledgeCutoff: 'Feb 2025',
                thinking: {
                    levels: ['none', 'low', 'medium', 'high'],
                    defaultLevel: 'none',
                },
            },
            tools: {
                webSearch: 'web_search_20250305',
                webFetch: 'web_fetch_20250910',
                codeExecution: 'code_execution_20250825',
            },
        },
        {
            id: 'claude-sonnet-4-5-20250929',
            name: 'Claude Sonnet 4.5',
            params: {
                contextWindow: 1000000,
                maxOutputTokens: 64000,
                defaultMaxTokens: 8192,
                temperatureMax: 1,
                defaultTemperature: 1,
                knowledgeCutoff: 'Jan 2025',
                thinking: {
                    levels: ['none', 'low', 'medium', 'high'],
                    defaultLevel: 'none',
                },
            },
            tools: {
                webSearch: 'web_search_20250305',
                webFetch: 'web_fetch_20250910',
                codeExecution: 'code_execution_20260120',
            },
        },
        {
            id: 'claude-opus-4-1-20250805',
            name: 'Claude Opus 4.1',
            params: {
                contextWindow: 200000,
                maxOutputTokens: 32000,
                defaultMaxTokens: 8192,
                temperatureMax: 1,
                defaultTemperature: 1,
                knowledgeCutoff: 'Jan 2025',
                thinking: {
                    levels: ['none', 'low', 'medium', 'high'],
                    defaultLevel: 'none',
                },
            },
            tools: {
                webSearch: 'web_search_20250305',
                webFetch: 'web_fetch_20250910',
                codeExecution: 'code_execution_20250825',
            },
        },
    ],
};
