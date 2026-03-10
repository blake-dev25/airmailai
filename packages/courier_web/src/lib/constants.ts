export const FONT_SIZES = [10, 12, 14, 16, 18, 20, 22, 24] as const;

export const THEMES: ReadonlyArray<{ id: string; name: string }> = [
	{ id: 'airmail-warm', name: 'Airmail Warm' },
	{ id: 'airmail-light', name: 'Airmail Light' },
	{ id: 'airmail-dark', name: 'Airmail Dark' },
];

export interface ModelParams {
	contextWindow: number;
	maxOutputTokens: number;
	defaultMaxTokens: number;
	temperatureMax: number; // 0 = no temperature support
	defaultTemperature: number;
	knowledgeCutoff: string;
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

// DO NOT MODIFY IDS/NAMES IN PROVIDERS
export const PROVIDERS: ProviderOption[] = [
	{
		id: 'anthropic',
		name: 'Anthropic',
		models: [
			{
				id: 'claude-opus-4-6',
				name: 'Claude Opus 4.6',
				params: {
					contextWindow: 200000,
					maxOutputTokens: 131072,
					defaultMaxTokens: 8192,
					temperatureMax: 1,
					defaultTemperature: 1,
					knowledgeCutoff: 'May 2025',
				},
			},
			{
				id: 'claude-sonnet-4-6',
				name: 'Claude Sonnet 4.6',
				params: {
					contextWindow: 200000,
					maxOutputTokens: 65536,
					defaultMaxTokens: 8192,
					temperatureMax: 1,
					defaultTemperature: 1,
					knowledgeCutoff: 'Aug 2025',
				},
			},
			{
				id: 'claude-haiku-4-5',
				name: 'Claude Haiku 4.5',
				params: {
					contextWindow: 200000,
					maxOutputTokens: 65536,
					defaultMaxTokens: 8192,
					temperatureMax: 1,
					defaultTemperature: 1,
					knowledgeCutoff: 'Feb 2025',
				},
			},
		],
	},
	{
		id: 'openai',
		name: 'OpenAI',
		models: [
			{
				id: 'gpt-5.2-pro',
				name: 'GPT-5.2 pro',
				params: {
					contextWindow: 400000,
					maxOutputTokens: 128000,
					defaultMaxTokens: 8192,
					temperatureMax: 2,
					defaultTemperature: 1,
					knowledgeCutoff: 'Aug 2025',
				},
			},
			{
				id: 'gpt-5.2',
				name: 'GPT-5.2',
				params: {
					contextWindow: 400000,
					maxOutputTokens: 128000,
					defaultMaxTokens: 8192,
					temperatureMax: 2,
					defaultTemperature: 1,
					knowledgeCutoff: 'Aug 2025',
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
		],
	},
	{
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
				},
			},
		],
	},
];
