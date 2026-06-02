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

// Per-tool support marker on a model.
//   - `true`  - model supports the tool; ext uses the provider's default factory
//   - string  - pinned tool variant (anthropic versions tool definitions by
//               date, e.g. 'web_search_20260209'). Ext passes the string straight
//               through as the Anthropic API tool `type`.
//   - falsy   - model does not support the tool
export type ToolSupport = boolean | string;

export interface ModelTools {
    webSearch?: ToolSupport;
    webFetch?: ToolSupport;
    codeExecution?: ToolSupport;
    searchFetchLinked?: boolean;
}

export interface ModelOption {
    id: string;
    name: string;
    params: ModelParams;
    tools?: ModelTools;
    inputModalities?: string[];
    vendor?: string;
}

export interface ProviderOption {
    id: string;
    name: string;
    models: ModelOption[];
    marketplace?: boolean;
}
