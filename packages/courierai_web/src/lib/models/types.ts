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
    // Marketplace providers (OpenRouter) attach the upstream vendor for
    // grouping in the picker — undefined for first-party providers.
    vendor?: string;
}

export interface ProviderOption {
    id: string;
    name: string;
    models: ModelOption[];
    // Marketplace providers bypass tier curation and group by vendor instead.
    // Defaults to false (first-party providers use the curated tier system).
    marketplace?: boolean;
}
