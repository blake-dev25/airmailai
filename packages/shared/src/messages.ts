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
	| { type: 'done'; usage?: { inputTokens: number; outputTokens: number } }
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

export interface ChatMeta {
	id: string;
	title: string;
	createdAt: number;
}

export interface StoredChat {
	id: string;
	title: string;
	createdAt: number;
	systemPrompt: string;
	messages: Array<{ role: 'user' | 'assistant'; content: string }>;
	tokens?: { input: number; output: number };
}

// Sent via chrome.runtime.sendMessage for one-off storage operations
export type StorageRequest =
	| { type: 'save_key'; provider: string; apiKey: string }
	| { type: 'has_keys'; providers: string[] }
	| { type: 'save_settings'; settings: Partial<UserSettings> }
	| { type: 'load_settings' }
	| { type: 'save_chat'; chat: StoredChat }
	| { type: 'delete_chat'; chatId: string }
	| { type: 'load_chat_titles' }
	| { type: 'load_chats' }
	| { type: 'load_chats_by_ids'; ids: string[] }
	| { type: 'load_chat'; chatId: string };

export type StorageResponse =
	| { type: 'saved' }
	| { type: 'has_keys'; saved: Record<string, boolean> }
	| { type: 'settings'; settings: Partial<UserSettings> }
	| { type: 'chat_titles'; titles: ChatMeta[] }
	| { type: 'chats'; chats: StoredChat[] }
	| { type: 'chat'; chat: StoredChat | null }
	| { type: 'error'; message: string };
