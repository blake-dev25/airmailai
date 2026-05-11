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

// Sent over a port (chrome.runtime.connect) for streaming chat. The 'start'
// message kicks off a turn; the extension owns the turn lifecycle from here
// (lock, stream, save). The web can send 'stop' mid-stream to cleanly halt
// and save with truncated visible content.
export interface TurnStartRequest {
    type: 'start';
    chatId: string;
    sourceTabId: string;
    provider: string;
    model: string;
    messages: ChatMessage[];
    params?: Record<string, unknown>;
    meta: ChatMeta;
    historyForSave: StoredChat['messages'];
}

export interface TurnStopRequest {
    type: 'stop';
    truncatedContent: string;
}

export type TurnRequest = TurnStartRequest | TurnStopRequest;

export type ExtensionResponse =
    | { type: 'chunk'; content: string }
    | { type: 'thinking_chunk'; content: string }
    | { type: 'done'; usage?: { inputTokens: number; outputTokens: number } }
    | { type: 'error'; message: string };

// Sent on the long-lived 'broadcast' port from the extension to every
// connected tab so tabs can mirror cross-tab turn lifecycle. The originating
// tab ignores its own turn-start (sourceTabId === own tabId); other events
// are classified by membership in remoteStreamingChatIds.
export type BroadcastEvent =
    | {
          type: 'turn-start';
          chatId: string;
          sourceTabId: string;
          meta: ChatMeta;
          history: StoredChat['messages'];
      }
    | {
          type: 'turn-chunk';
          chatId: string;
          kind: 'content' | 'thinking';
          delta: string;
      }
    | { type: 'turn-done'; chatId: string }
    | { type: 'turn-error'; chatId: string; message: string }
    | { type: 'turn-aborted'; chatId: string };

export interface StreamUsage {
    inputTokens: number;
    outputTokens: number;
}

// Shared stream-callback shape for both the provider implementations
// (in the extension background) and the web-side `sendToExtension` wrapper.
export interface StreamHandlers {
    onChunk: (text: string) => void;
    onThinking?: (text: string) => void;
    onDone: (usage?: StreamUsage) => void;
    onError: (message: string) => void;
}

export interface UserSettings {
    theme: string;
    fontSizeIndex: number;
    chatWidth: number;
    smoothTextMode: 'smooth' | 'boost-on-complete' | 'dump-on-complete' | 'raw';
    submitKeystroke: 'enter' | 'ctrl+enter';
    modelTier: 'latest' | 'previous' | 'legacy';
    autoscroll: boolean;
    providerId: string;
    modelId: string;
    temperature: number;
    maxTokens: number;
    thinkingLevel: string;
    adaptiveThinking: boolean;
    tagOpenRouterRequests: boolean;
    openRouterFreeModels: 'show' | 'only' | 'hide';
    syncApiKeys: boolean;
    // Content hash of the last accepted ToS/Privacy pair. Empty/missing = never agreed.
    legalAcceptedVersion: string;
}

// The mapped-type constraint forces every UserSettings field to appear here —
// adding a field to UserSettings without listing it here is a compile error.
const SETTINGS_KEY_MAP: { [K in keyof UserSettings]: 0 } = {
    theme: 0,
    fontSizeIndex: 0,
    chatWidth: 0,
    smoothTextMode: 0,
    submitKeystroke: 0,
    modelTier: 0,
    autoscroll: 0,
    providerId: 0,
    modelId: 0,
    temperature: 0,
    maxTokens: 0,
    thinkingLevel: 0,
    adaptiveThinking: 0,
    tagOpenRouterRequests: 0,
    openRouterFreeModels: 0,
    syncApiKeys: 0,
    legalAcceptedVersion: 0,
};
export const SETTINGS_KEYS = Object.keys(
    SETTINGS_KEY_MAP
) as (keyof UserSettings)[];

export interface ChatMeta {
    id: string;
    title: string;
    createdAt: number;
    providerId: string;
    modelId: string;
    temperature: number;
    maxTokens: number;
    thinkingLevel: string;
    adaptiveThinking: boolean;
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

// OpenRouter's models API returns rich metadata, so we hydrate the picker at
// runtime instead of curating locally. Lives in the extension's
// chrome.storage.local cache; served to the web via load_openrouter_models.
export interface OpenRouterModel {
    id: string;
    name: string;
    vendor: string;
    contextWindow: number;
    maxOutputTokens: number;
    inputModalities: string[];
    supportedParams: string[];
    free: boolean;
    created: number;
}

// Sent via chrome.runtime.sendMessage for one-off storage operations
export type StorageRequest =
    | {
          type: 'save_key';
          provider: string;
          apiKey: string;
          syncApiKeys: boolean;
      }
    | { type: 'clear_key'; provider: string }
    | { type: 'has_keys'; providers: string[] }
    | { type: 'save_settings'; settings: Partial<UserSettings> }
    | { type: 'load_settings' }
    | { type: 'save_chat'; chat: StoredChat; meta: ChatMeta }
    | { type: 'delete_chat'; chatId: string }
    | { type: 'load_chat_metas' }
    | { type: 'load_chats' }
    | { type: 'load_chats_by_ids'; ids: string[] }
    | { type: 'load_chat'; chatId: string }
    | { type: 'load_openrouter_models' };

export type StorageResponse =
    | { type: 'saved' }
    | { type: 'has_keys'; saved: Record<string, boolean> }
    | { type: 'settings'; settings: Partial<UserSettings> }
    | { type: 'chat_metas'; metas: ChatMeta[] }
    | { type: 'chats'; chats: StoredChat[] }
    | { type: 'chat'; chat: StoredChat | null }
    | { type: 'openrouter_models'; models: OpenRouterModel[] | null }
    | { type: 'error'; message: string };
