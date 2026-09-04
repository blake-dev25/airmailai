import type { ProviderOption } from './types';

// *** NOTE FOR LLMS: NEVER MANUALLY MODIFY IDS/NAMES, THEY ARE CORRECT
// This file is automatically written over by scripts/update-model-list.ts, edits will not be saved
export const OPENAI: ProviderOption = {
    id: 'openai',
    name: 'OpenAI',
    models: [
        {
            id: 'gpt-5.6-luna',
            name: 'GPT-5.6 Luna',
            params: {
                contextWindow: 1050000,
                maxOutputTokens: 128000,
                defaultMaxTokens: 8192,
                knowledgeCutoff: 'Feb 2026',
                thinking: {
                    levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
                    defaultLevel: 'medium',
                },
            },
        },
        {
            id: 'gpt-5.6-sol',
            name: 'GPT-5.6 Sol',
            params: {
                contextWindow: 1050000,
                maxOutputTokens: 128000,
                defaultMaxTokens: 8192,
                knowledgeCutoff: 'Feb 2026',
                thinking: {
                    levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
                    defaultLevel: 'medium',
                },
            },
        },
        {
            id: 'gpt-5.6-terra',
            name: 'GPT-5.6 Terra',
            params: {
                contextWindow: 1050000,
                maxOutputTokens: 128000,
                defaultMaxTokens: 8192,
                knowledgeCutoff: 'Feb 2026',
                thinking: {
                    levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
                    defaultLevel: 'medium',
                },
            },
        },
        {
            id: 'gpt-5.5',
            name: 'GPT-5.5',
            params: {
                contextWindow: 1050000,
                maxOutputTokens: 128000,
                defaultMaxTokens: 8192,
                knowledgeCutoff: 'Dec 2025',
                thinking: {
                    levels: ['none', 'low', 'medium', 'high', 'xhigh'],
                    defaultLevel: 'medium',
                },
            },
        },
        {
            id: 'gpt-5.5-pro',
            name: 'GPT-5.5 Pro',
            params: {
                contextWindow: 1050000,
                maxOutputTokens: 128000,
                defaultMaxTokens: 8192,
                knowledgeCutoff: 'Dec 2025',
                thinking: {
                    levels: ['medium', 'high', 'xhigh'],
                    defaultLevel: 'high',
                },
            },
        },
        {
            id: 'gpt-5.4',
            name: 'GPT-5.4',
            params: {
                contextWindow: 1050000,
                maxOutputTokens: 128000,
                defaultMaxTokens: 8192,
                knowledgeCutoff: 'Aug 2025',
                thinking: {
                    levels: ['none', 'low', 'medium', 'high', 'xhigh'],
                    defaultLevel: 'none',
                },
            },
        },
        {
            id: 'gpt-5.4-mini',
            name: 'GPT-5.4 Mini',
            params: {
                contextWindow: 400000,
                maxOutputTokens: 128000,
                defaultMaxTokens: 8192,
                knowledgeCutoff: 'Aug 2025',
                thinking: {
                    levels: ['none', 'low', 'medium', 'high', 'xhigh'],
                    defaultLevel: 'none',
                },
            },
        },
        {
            id: 'gpt-5.4-nano',
            name: 'GPT-5.4 Nano',
            params: {
                contextWindow: 400000,
                maxOutputTokens: 128000,
                defaultMaxTokens: 8192,
                knowledgeCutoff: 'Aug 2025',
                thinking: {
                    levels: ['none', 'low', 'medium', 'high', 'xhigh'],
                    defaultLevel: 'none',
                },
            },
        },
        {
            id: 'gpt-5.4-pro',
            name: 'GPT-5.4 Pro',
            params: {
                contextWindow: 1050000,
                maxOutputTokens: 128000,
                defaultMaxTokens: 8192,
                knowledgeCutoff: 'Aug 2025',
                thinking: {
                    levels: ['medium', 'high', 'xhigh'],
                    defaultLevel: 'medium',
                },
            },
        },
        {
            id: 'gpt-5.3-codex',
            name: 'GPT-5.3-Codex',
            params: {
                contextWindow: 400000,
                maxOutputTokens: 128000,
                defaultMaxTokens: 8192,
                knowledgeCutoff: 'Aug 2025',
                thinking: {
                    levels: ['none', 'low', 'medium', 'high', 'xhigh'],
                    defaultLevel: 'none',
                },
            },
        },
        {
            id: 'gpt-5.2',
            name: 'GPT-5.2',
            params: {
                contextWindow: 400000,
                maxOutputTokens: 128000,
                defaultMaxTokens: 8192,
                knowledgeCutoff: 'Aug 2025',
                thinking: {
                    levels: ['none', 'low', 'medium', 'high', 'xhigh'],
                    defaultLevel: 'none',
                },
            },
        },
        {
            id: 'gpt-5.2-pro',
            name: 'GPT-5.2 Pro',
            params: {
                contextWindow: 400000,
                maxOutputTokens: 128000,
                defaultMaxTokens: 8192,
                knowledgeCutoff: 'Aug 2025',
                thinking: {
                    levels: ['medium', 'high', 'xhigh'],
                    defaultLevel: 'medium',
                },
            },
        },
        {
            id: 'gpt-5.1',
            name: 'GPT-5.1',
            params: {
                contextWindow: 400000,
                maxOutputTokens: 128000,
                defaultMaxTokens: 8192,
                knowledgeCutoff: 'Sep 2024',
                thinking: {
                    levels: ['none', 'low', 'medium', 'high'],
                    defaultLevel: 'none',
                },
            },
        },
        {
            id: 'gpt-5',
            name: 'GPT-5',
            params: {
                contextWindow: 400000,
                maxOutputTokens: 128000,
                defaultMaxTokens: 8192,
                knowledgeCutoff: 'Sep 2024',
                thinking: {
                    levels: ['minimal', 'low', 'medium', 'high'],
                    defaultLevel: 'minimal',
                },
            },
        },
        {
            id: 'gpt-5-mini',
            name: 'GPT-5 Mini',
            params: {
                contextWindow: 400000,
                maxOutputTokens: 128000,
                defaultMaxTokens: 8192,
                knowledgeCutoff: 'May 2024',
                thinking: {
                    levels: ['minimal', 'low', 'medium', 'high'],
                    defaultLevel: 'minimal',
                },
            },
        },
        {
            id: 'gpt-5-nano',
            name: 'GPT-5 Nano',
            params: {
                contextWindow: 400000,
                maxOutputTokens: 128000,
                defaultMaxTokens: 8192,
                knowledgeCutoff: 'May 2024',
                thinking: {
                    levels: ['minimal', 'low', 'medium', 'high'],
                    defaultLevel: 'minimal',
                },
            },
        },
        {
            id: 'gpt-5-pro',
            name: 'GPT-5 Pro',
            params: {
                contextWindow: 400000,
                maxOutputTokens: 272000,
                defaultMaxTokens: 8192,
                knowledgeCutoff: 'Sep 2024',
                thinking: {
                    levels: ['high'],
                    defaultLevel: 'high',
                },
            },
        },
        {
            id: 'gpt-4.1',
            name: 'GPT-4.1',
            params: {
                contextWindow: 1047576,
                maxOutputTokens: 32768,
                defaultMaxTokens: 8192,
                temperatureMax: 2,
                defaultTemperature: 1,
                knowledgeCutoff: 'Jun 2024',
            },
        },
        {
            id: 'gpt-4.1-mini',
            name: 'GPT-4.1 Mini',
            params: {
                contextWindow: 1047576,
                maxOutputTokens: 32768,
                defaultMaxTokens: 8192,
                temperatureMax: 2,
                defaultTemperature: 1,
                knowledgeCutoff: 'Jun 2024',
            },
        },
        {
            id: 'gpt-4.1-nano',
            name: 'GPT-4.1 Nano',
            params: {
                contextWindow: 1047576,
                maxOutputTokens: 32768,
                defaultMaxTokens: 8192,
                temperatureMax: 2,
                defaultTemperature: 1,
                knowledgeCutoff: 'Jun 2024',
            },
        },
        {
            id: 'gpt-4',
            name: 'GPT-4',
            params: {
                contextWindow: 8192,
                maxOutputTokens: 8192,
                defaultMaxTokens: 8192,
                temperatureMax: 2,
                defaultTemperature: 1,
                knowledgeCutoff: 'Dec 2023',
            },
        },
        {
            id: 'gpt-4-turbo',
            name: 'GPT-4 Turbo',
            params: {
                contextWindow: 128000,
                maxOutputTokens: 4096,
                defaultMaxTokens: 4096,
                temperatureMax: 2,
                defaultTemperature: 1,
                knowledgeCutoff: 'Dec 2023',
            },
        },
        {
            id: 'gpt-4o',
            name: 'GPT-4o',
            params: {
                contextWindow: 128000,
                maxOutputTokens: 16384,
                defaultMaxTokens: 8192,
                temperatureMax: 2,
                defaultTemperature: 1,
                knowledgeCutoff: 'Oct 2023',
            },
        },
        {
            id: 'gpt-4o-mini',
            name: 'GPT-4o-mini',
            params: {
                contextWindow: 128000,
                maxOutputTokens: 16384,
                defaultMaxTokens: 8192,
                temperatureMax: 2,
                defaultTemperature: 1,
                knowledgeCutoff: 'Oct 2023',
            },
        },
        {
            id: 'o4-mini',
            name: 'o4 Mini',
            params: {
                contextWindow: 200000,
                maxOutputTokens: 100000,
                defaultMaxTokens: 8192,
                knowledgeCutoff: 'Jun 2024',
                thinking: {
                    levels: ['low', 'medium', 'high'],
                    defaultLevel: 'medium',
                },
            },
        },
        {
            id: 'gpt-3.5-turbo',
            name: 'GPT-3.5 Turbo',
            params: {
                contextWindow: 16385,
                maxOutputTokens: 4096,
                defaultMaxTokens: 4096,
                temperatureMax: 2,
                defaultTemperature: 1,
                knowledgeCutoff: 'Sep 2021',
            },
        },
        {
            id: 'gpt-3.5-turbo-16k',
            name: 'GPT-3.5 Turbo 16k',
            params: {
                contextWindow: 16385,
                maxOutputTokens: 4096,
                defaultMaxTokens: 4096,
                temperatureMax: 2,
                defaultTemperature: 1,
                knowledgeCutoff: 'Sep 2021',
            },
        },
        {
            id: 'o3',
            name: 'o3',
            params: {
                contextWindow: 200000,
                maxOutputTokens: 100000,
                defaultMaxTokens: 8192,
                knowledgeCutoff: 'Jun 2024',
                thinking: {
                    levels: ['low', 'medium', 'high'],
                    defaultLevel: 'medium',
                },
            },
        },
        {
            id: 'o3-mini',
            name: 'o3 Mini',
            params: {
                contextWindow: 200000,
                maxOutputTokens: 100000,
                defaultMaxTokens: 8192,
                knowledgeCutoff: 'Oct 2023',
                thinking: {
                    levels: ['low', 'medium', 'high'],
                    defaultLevel: 'medium',
                },
            },
        },
        {
            id: 'o3-pro',
            name: 'o3 Pro',
            params: {
                contextWindow: 200000,
                maxOutputTokens: 100000,
                defaultMaxTokens: 8192,
                knowledgeCutoff: 'Jun 2024',
                thinking: {
                    levels: ['low', 'medium', 'high'],
                    defaultLevel: 'medium',
                },
            },
        },
        {
            id: 'o1',
            name: 'o1',
            params: {
                contextWindow: 200000,
                maxOutputTokens: 100000,
                defaultMaxTokens: 8192,
                knowledgeCutoff: 'Oct 2023',
                thinking: {
                    levels: ['low', 'medium', 'high'],
                    defaultLevel: 'medium',
                },
            },
        },
        {
            id: 'o1-pro',
            name: 'o1-pro',
            params: {
                contextWindow: 200000,
                maxOutputTokens: 100000,
                defaultMaxTokens: 8192,
                knowledgeCutoff: 'Oct 2023',
                thinking: {
                    levels: ['low', 'medium', 'high'],
                    defaultLevel: 'medium',
                },
            },
        },
    ],
};
