export type ThinkingLevel =
    | 'none'
    | 'minimal'
    | 'low'
    | 'medium'
    | 'high'
    | 'max'
    | 'xhigh';

export type ModelTier = 'latest' | 'previous' | 'legacy';

export interface ModelParams {
    contextWindow: number;
    maxOutputTokens: number;
    defaultMaxTokens: number;
    temperatureMax?: number;
    defaultTemperature?: number;
    knowledgeCutoff?: string;
    thinking?: {
        levels: ThinkingLevel[];
        defaultLevel: ThinkingLevel;
        adaptive?: 'optional' | 'required';
    };
}

export interface ModelOption {
    id: string;
    name: string;
    params: ModelParams;
}

export interface ProviderOption {
    id: string;
    name: string;
    models: ModelOption[];
}
