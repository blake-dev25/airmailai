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

export interface UserSettings {
	theme: string;
	fontSizeIndex: number;
	chatWidth: number;
	providerId: string;
	modelId: string;
	temperature: number;
	maxTokens: number;
}

export const SETTINGS_KEYS: (keyof UserSettings)[] = [
	'theme',
	'fontSizeIndex',
	'chatWidth',
	'providerId',
	'modelId',
	'temperature',
	'maxTokens',
];

export interface StoredChat {
	id: string;
	title: string;
	createdAt: number;
	systemPrompt: string;
	messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}

// Sent via chrome.runtime.sendMessage for one-off storage operations
export type StorageRequest =
	| { type: 'save_key'; provider: string; apiKey: string }
	| { type: 'has_keys'; providers: string[] }
	| { type: 'save_settings'; settings: Partial<UserSettings> }
	| { type: 'load_settings' }
	| { type: 'save_chat'; chat: StoredChat }
	| { type: 'delete_chat'; chatId: string }
	| { type: 'load_chats' };

export type StorageResponse =
	| { type: 'saved' }
	| { type: 'has_keys'; saved: Record<string, boolean> }
	| { type: 'settings'; settings: Partial<UserSettings> }
	| { type: 'chats'; chats: StoredChat[] }
	| { type: 'error'; message: string };
