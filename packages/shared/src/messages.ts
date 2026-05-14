// Persisted form. Carries everything needed to render an attachment chip and
// look up the bytes by content-hash. Storage lives in the ext's `files` IDB
// store keyed by `hash`, dedup'd via refCount across chats.
export interface AttachmentRef {
    hash: string; // SHA-256 of raw bytes
    name: string;
    mediaType: string;
    sizeBytes: number;
}

// In-flight form. Adds the base64-encoded bytes used by provider request
// shapers. `data` is only present for fresh uploads on the current turn —
// history attachments arrive as bare refs and are hydrated by the ext from
// its files store before reaching the provider.
export interface Attachment extends AttachmentRef {
    encodedSizeBytes: number;
    data: string; // base64
}

// A single source captured from a provider's web search tool. `title` is
// optional from our perspective but Anthropic's SDK requires it on re-send,
// so the provider's send-side shaper falls back to `url` when absent.
// `anthropicEncrypted` is Anthropic's opaque `encrypted_content` blob,
// required to preserve citation continuity across turns; empty/omitted for
// providers that don't surface it.
export interface WebSearchSource {
    url: string;
    title?: string;
    anthropicEncrypted?: string;
}

// One block of web-search output, mirroring a single provider tool call.
// `callId` is the real id from the API (anthropic `server_tool_use.id`,
// openai `web_search_call.id`); absent when the provider doesn't surface
// one we can reuse (google), or when we don't re-inject (openrouter).
export interface WebSearchToolResult {
    type: 'web_search';
    callId?: string;
    sources: WebSearchSource[];
}

// Discriminated union — only `web_search` today, expand later if other
// server-side tools land.
export type ToolResult = WebSearchToolResult;

export interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    // Union: fresh uploads on the current turn carry full Attachment (with
    // data); history items are AttachmentRef and get hydrated server-side.
    attachments?: (Attachment | AttachmentRef)[];
    // Assistant-only. Carried forward in history so each provider can
    // reconstruct its native tool-call blocks on the next turn.
    toolResults?: ToolResult[];
}

// Post-hydration form. The ext fills bare refs into full attachments before
// handing off to providers, so this is what provider stream fns consume.
export interface HydratedChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    attachments?: Attachment[];
    toolResults?: ToolResult[];
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

// No-op heartbeat sent over the existing stream port while a provider is
// quiet. Chrome MV3 keeps the worker alive when messages move over a port;
// simply having the port open is not enough.
export interface TurnKeepaliveRequest {
    type: 'keepalive';
}

export type TurnRequest =
    | TurnStartRequest
    | TurnStopRequest
    | TurnKeepaliveRequest;

export type ExtensionResponse =
    | { type: 'chunk'; content: string }
    | { type: 'thinking_chunk'; content: string }
    | { type: 'tool_results'; toolResults: ToolResult[] }
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
    | {
          type: 'turn-tool-results';
          chatId: string;
          toolResults: ToolResult[];
      }
    | { type: 'turn-done'; chatId: string }
    | { type: 'turn-error'; chatId: string; message: string }
    | { type: 'turn-aborted'; chatId: string };

// Sent from each connected tab over the broadcast port. Only used as a
// global heartbeat: as long as any tab has the website open, the keepalive
// resets the SW's 30s idle timer so it stays warm for cross-tab fan-out
// and for the next turn without a cold-start round trip.
export interface BroadcastKeepaliveRequest {
    type: 'keepalive';
}
export type BroadcastRequest = BroadcastKeepaliveRequest;

export interface StreamUsage {
    inputTokens: number;
    outputTokens: number;
}

export type StreamErrorSource = 'api' | 'extension';

// Shared stream-callback shape for both the provider implementations
// (in the extension background) and the web-side `sendToExtension` wrapper.
export interface StreamHandlers {
    onChunk: (text: string) => void;
    onThinking?: (text: string) => void;
    // Structured tool-call output collected at the end of a stream. Emitted
    // at most once per turn, after the content stream completes.
    onToolResults?: (toolResults: ToolResult[]) => void;
    onDone: (usage?: StreamUsage) => void;
    onError: (message: string, source?: StreamErrorSource) => void;
}

export interface UserSettings {
    theme: string;
    fontSizeIndex: number;
    chatWidth: number;
    smoothTextMode: 'smooth' | 'boost-on-complete' | 'dump-on-complete' | 'raw';
    submitKeystroke: 'enter' | 'ctrl+enter';
    modelTier: 'latest' | 'previous' | 'legacy';
    autoscroll: boolean;
    enableWebSearch: boolean;
    providerId: string;
    modelId: string;
    temperature: number;
    maxTokens: number;
    thinkingLevel: string;
    adaptiveThinking: boolean;
    webSearch: boolean;
    tagOpenRouterRequests: boolean;
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
    enableWebSearch: 0,
    providerId: 0,
    modelId: 0,
    temperature: 0,
    maxTokens: 0,
    thinkingLevel: 0,
    adaptiveThinking: 0,
    webSearch: 0,
    tagOpenRouterRequests: 0,
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
    webSearch: boolean;
    systemPrompt: string;
}

export interface StoredChat {
    id: string;
    messages: Array<{
        role: 'user' | 'assistant';
        content: string;
        thinking?: string;
        attachments?: AttachmentRef[];
        toolResults?: ToolResult[];
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
