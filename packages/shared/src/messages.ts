export interface Attachment {
  name: string;
  mediaType: string;
  data: string; // base64
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  attachments?: Attachment[];
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
  | { type: 'thinking_chunk'; content: string }
  | { type: 'done'; usage?: { inputTokens: number; outputTokens: number } }
  | { type: 'error'; message: string };

export interface UserSettings {
  theme: string;
  fontSizeIndex: number;
  chatWidth: number;
  smoothText: boolean;
  providerId: string;
  modelId: string;
  temperature: number;
  maxTokens: number;
  thinkingLevel: string;
}

export const SETTINGS_KEYS: (keyof UserSettings)[] = [
  'theme',
  'fontSizeIndex',
  'chatWidth',
  'smoothText',
  'providerId',
  'modelId',
  'temperature',
  'maxTokens',
  'thinkingLevel',
];

export interface ChatMeta {
  id: string;
  title: string;
  createdAt: number;
  providerId: string;
  modelId: string;
  temperature: number;
  maxTokens: number;
  thinkingLevel: string;
  systemPrompt: string;
}

export interface StoredChat {
  id: string;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
    thinking?: string;
    attachments?: Attachment[];
  }>;
  tokens?: { input: number; output: number };
}

// Sent via chrome.runtime.sendMessage for one-off storage operations
export type StorageRequest =
  | { type: 'save_key'; provider: string; apiKey: string }
  | { type: 'clear_key'; provider: string }
  | { type: 'has_keys'; providers: string[] }
  | { type: 'save_settings'; settings: Partial<UserSettings> }
  | { type: 'load_settings' }
  | { type: 'save_chat'; chat: StoredChat; meta: ChatMeta }
  | { type: 'delete_chat'; chatId: string }
  | { type: 'load_chat_metas' }
  | { type: 'load_chats' }
  | { type: 'load_chats_by_ids'; ids: string[] }
  | { type: 'load_chat'; chatId: string };

export type StorageResponse =
  | { type: 'saved' }
  | { type: 'has_keys'; saved: Record<string, boolean> }
  | { type: 'settings'; settings: Partial<UserSettings> }
  | { type: 'chat_metas'; metas: ChatMeta[] }
  | { type: 'chats'; chats: StoredChat[] }
  | { type: 'chat'; chat: StoredChat | null }
  | { type: 'error'; message: string };
