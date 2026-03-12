export interface ChatMessage {
	role: 'user' | 'assistant' | 'system';
	content: string;
}

// Sent over a port (chrome.runtime.connect) for streaming chat
export interface ExtensionRequest {
	provider: string;
	model: string;
	messages: ChatMessage[];
	params?: Record<string, unknown>;
}

export type ExtensionResponse =
	| { type: 'chunk'; content: string }
	| { type: 'done' }
	| { type: 'error'; message: string };

// Sent via chrome.runtime.sendMessage for one-off storage operations
export type StorageRequest =
	| { type: 'save_key'; provider: string; apiKey: string }
	| { type: 'has_keys'; providers: string[] };

export type StorageResponse =
	| { type: 'saved' }
	| { type: 'has_keys'; saved: Record<string, boolean> }
	| { type: 'error'; message: string };
