export interface ChatMessage {
	role: 'user' | 'assistant' | 'system';
	content: string;
}

export interface ExtensionRequest {
	provider: string;
	model: string;
	apiKey: string;
	messages: ChatMessage[];
	params?: Record<string, unknown>;
}

export type ExtensionResponse =
	| { type: 'chunk'; content: string }
	| { type: 'done' }
	| { type: 'error'; message: string };
