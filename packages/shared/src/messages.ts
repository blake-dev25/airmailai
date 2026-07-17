export interface DraftAttachmentMeta {
    name: string;
    mediaType: string;
    sizeBytes: number;
    encodedSizeBytes: number;
}

export interface DraftAttachment extends DraftAttachmentMeta {
    hash: string;
}

export interface AirmailAIMessageMetadata {
    createdAt: number;
    model?: string;
    tokens?: { input: number; output: number };
    stopReason?: 'stop' | 'length' | 'refusal' | 'content-filter' | 'error';
}

export type AirmailAIToolName = 'web_search' | 'web_fetch' | 'code_execution';

export type AirmailAIPart =
    | AirmailAITextPart
    | AirmailAIReasoningPart
    | AirmailAIToolPart
    | AirmailAISourceUrlPart
    | AirmailAISourceDocumentPart
    | AirmailAICitationPart
    | AirmailAIGoogleSearchSuggestionsPart
    | AirmailAIFilePart;

export interface AirmailAITextPart {
    type: 'text';
    text: string;
    state: 'streaming' | 'done';
}

// thinking / reasoning summary.
export interface AirmailAIReasoningPart {
    type: 'reasoning';
    text: string;
    state: 'streaming' | 'done';
}

type AirmailAIToolPartBase = {
    type: 'tool';
    toolCallId: string;
    state: 'running' | 'done' | 'error';
    errorText?: string;
};
export type AirmailAIToolPart =
    | (AirmailAIToolPartBase & {
          name: 'web_search';
          input?: { query?: string };
      })
    | (AirmailAIToolPartBase & { name: 'web_fetch'; input?: { url?: string } })
    | (AirmailAIToolPartBase & {
          name: 'code_execution';
          input?: { code?: string };
          output?: { stdout?: string; stderr?: string };
      });

export interface AirmailAISourceUrlPart {
    type: 'source-url';
    sourceId: string;
    url: string;
    title?: string;
}

export interface AirmailAISourceDocumentPart {
    type: 'source-document';
    sourceId: string;
    title?: string;
    mediaType?: string;
    hash?: string;
}

export interface AirmailAICitationPart {
    type: 'citation';
    sourceId: string;
    textIndex: number;
    textEnd: number;
    textStart?: number;
    citedText?: string;
    location?: { kind: 'page' | 'char'; start: number; end: number };
}

export interface AirmailAIGoogleSearchSuggestionsPart {
    type: 'google-search-suggestions';
    html: string;
}

export interface AirmailAIFilePart {
    type: 'file';
    filename: string;
    mediaType: string;
    sizeBytes: number;
    hash: string;
}

export type FileDeleteTarget =
    | { kind: 'local'; hash: string }
    | { kind: 'provider'; providerId: string; fileId: string };

export type FileAvailability = 'local' | 'provider' | 'expired' | 'missing';

export interface AirmailAIMessage {
    id: string;
    role: 'user' | 'assistant';
    parts: AirmailAIPart[];
    metadata: AirmailAIMessageMetadata;
}

export type AirmailAIChunk =
    | { type: 'text-start'; id: string }
    | { type: 'text-delta'; id: string; delta: string }
    | { type: 'text-end'; id: string }
    | { type: 'reasoning-start'; id: string }
    | { type: 'reasoning-delta'; id: string; delta: string }
    | { type: 'reasoning-end'; id: string }
    | {
          type: 'tool-call';
          toolCallId: string;
          name: 'web_search';
          input?: { query?: string };
      }
    | {
          type: 'tool-call';
          toolCallId: string;
          name: 'web_fetch';
          input?: { url?: string };
      }
    | {
          type: 'tool-call';
          toolCallId: string;
          name: 'code_execution';
          input?: { code?: string };
      }
    | {
          type: 'tool-result';
          toolCallId: string;
          output?: { stdout?: string; stderr?: string };
          errorText?: string;
      }
    | {
          type: 'source-url';
          sourceId: string;
          url: string;
          title?: string;
      }
    | {
          type: 'source-document';
          sourceId: string;
          title?: string;
          mediaType?: string;
          hash?: string;
      }
    | {
          type: 'citation';
          sourceId: string;
          textId: string;
          textStart?: number;
          textEnd?: number;
          citedText?: string;
          location?: { kind: 'page' | 'char'; start: number; end: number };
      }
    | { type: 'google-search-suggestions'; html: string }
    | {
          type: 'file';
          filename: string;
          mediaType: string;
          sizeBytes: number;
          hash: string;
          base64?: string;
          replicaFileId?: string;
      }
    | {
          type: 'start';
          messageId?: string;
          metadata?: Partial<AirmailAIMessageMetadata>;
      }
    | {
          type: 'finish';
          metadata?: Partial<AirmailAIMessageMetadata>;
          containerId?: string;
          containerExpiresAt?: string;
      };

export interface ProviderStreamArgs {
    apiKey: string;
    model: string;
    messages: AirmailAIMessage[];
    system?: string;
    params: Record<string, unknown>;
    signal?: AbortSignal;
    blobs?: Record<string, { mediaType: string; base64: string }>;
    providerFiles?: Record<string, ProviderFileEntry>;
}
export type ProviderStream = (
    args: ProviderStreamArgs
) => AsyncIterable<AirmailAIChunk>;

export interface StoredMessage {
    chatId: string;
    message: AirmailAIMessage;
}

export interface HydratedStoredMessage {
    chatId: string;
    message: AirmailAIMessage;
    freshBlobs?: Record<string, { mediaType: string; base64: string }>;
}

export interface TurnStartRequest {
    type: 'start';
    chatId: string;
    sourceTabId: string;
    provider: string;
    model: string;
    messages: AirmailAIMessage[];
    system?: string;
    params?: Record<string, unknown>;
    meta: ChatMeta;
    assistantMessageId: string;
    assistantCreatedAt: number;
}

export interface TurnStopRequest {
    type: 'stop';
    truncateTo: number;
}

export type TurnRequest = TurnStartRequest | TurnStopRequest;

export type StreamErrorSource = 'api' | 'extension';

export type ExtensionStreamEvent =
    | { type: 'chunk'; chunk: AirmailAIChunk }
    | { type: 'done' }
    | { type: 'error'; source: StreamErrorSource; message: string };

export type BroadcastEvent =
    | { type: 'ext-hello'; version: string }
    | {
          type: 'turn-start';
          chatId: string;
          sourceTabId: string;
          meta: ChatMeta;
          assistantMessageId: string;
          assistantCreatedAt: number;
      }
    | {
          type: 'turn-chunk';
          chatId: string;
          chunk: AirmailAIChunk;
      }
    | { type: 'turn-done'; chatId: string }
    | {
          type: 'turn-error';
          chatId: string;
          message: string;
          source?: StreamErrorSource;
      }
    | { type: 'turn-aborted'; chatId: string }
    | { type: 'turn-truncate'; chatId: string; charLen: number }
    | { type: 'files-changed'; chatIds: string[] }
    | { type: 'meta-changed'; meta: ChatMeta }
    | { type: 'chat-deleted'; chatId: string }
    | { type: 'chats-cleared' };

export interface BroadcastRegisterRequest {
    type: 'register';
    sourceTabId: string;
}
export interface BroadcastKeepaliveRequest {
    type: 'keepalive';
}
export type BroadcastRequest =
    BroadcastRegisterRequest | BroadcastKeepaliveRequest;

export interface UserSettings {
    theme: string;
    fontSizeIndex: number;
    chatWidth: number;
    smoothTextMode: 'smooth' | 'raw';
    submitKeystroke: 'enter' | 'ctrl+enter';
    modelTier: 'latest' | 'previous' | 'legacy';
    autoscrollMode: 'pin-user-message' | 'pin-bottom' | 'off';
    chatSortOrder: 'modified' | 'created';
    enableWebSearch: boolean;
    enableWebFetch: boolean;
    enableCodeExecution: boolean;
    enableFileUploads: boolean;
    enableProviderFileStorage: boolean;
    providerId: string;
    modelId: string;
    temperature: number;
    maxTokens: number;
    thinkingLevel: string;
    adaptiveThinking: boolean;
    tagOpenRouterRequests: boolean;
    openRouterPdfEngine: 'native' | 'auto' | 'cloudflare-ai' | 'mistral-ocr';
    showBranding: boolean;
    messageFont: 'serif' | 'sans';
    legalAcceptedVersion: string;
}

const SETTINGS_KEY_MAP: { [K in keyof UserSettings]: 0 } = {
    theme: 0,
    fontSizeIndex: 0,
    chatWidth: 0,
    smoothTextMode: 0,
    submitKeystroke: 0,
    modelTier: 0,
    autoscrollMode: 0,
    chatSortOrder: 0,
    enableWebSearch: 0,
    enableWebFetch: 0,
    enableCodeExecution: 0,
    enableFileUploads: 0,
    enableProviderFileStorage: 0,
    providerId: 0,
    modelId: 0,
    temperature: 0,
    maxTokens: 0,
    thinkingLevel: 0,
    adaptiveThinking: 0,
    tagOpenRouterRequests: 0,
    openRouterPdfEngine: 0,
    showBranding: 0,
    messageFont: 0,
    legalAcceptedVersion: 0,
};
export const SETTINGS_KEYS = Object.keys(
    SETTINGS_KEY_MAP
) as (keyof UserSettings)[];

export interface ChatMeta {
    id: string;
    title: string;
    createdAt: number;
    lastMessageAt?: number;
    providerId: string;
    modelId: string;
    temperature: number;
    maxTokens: number;
    thinkingLevel: string;
    adaptiveThinking: boolean;
    webSearch: boolean;
    webFetch: boolean;
    codeExecution: boolean;
    systemPrompt: string;
    draftAttachments?: DraftAttachment[];
    containerId?: string;
    containerExpiresAt?: string;
    containerFileIds?: string[];
}

export interface StoredChat {
    id: string;
    messages: StoredMessage[];
}

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

export interface LocalFileInfo {
    hash: string;
    filename: string;
    mediaType: string;
    sizeBytes: number;
    createdAt: number;
}

export interface ProviderFileInfo {
    fileId: string;
    filename: string;
    mediaType: string;
    sizeBytes: number;
    createdAt: number;
    hash?: string;
}

export interface ProviderFileRef {
    providerId: string;
    fileId: string;
}

export interface ProviderFileEntry {
    fileId: string;
    uri?: string;
    expiresAt?: number;
}

export type StorageRequest =
    | { type: 'save_key'; provider: string; apiKey: string }
    | { type: 'clear_key'; provider: string }
    | { type: 'has_keys'; providers: string[] }
    | { type: 'test_key'; provider: string }
    | { type: 'save_settings'; settings: Partial<UserSettings> }
    | { type: 'load_settings' }
    | { type: 'save_meta'; meta: ChatMeta; sourceTabId?: string }
    | {
          type: 'stage_draft_attachment';
          chatId: string;
          attachment: DraftAttachment;
          base64: string;
          replicateTo?: string;
      }
    | { type: 'remove_draft_attachment'; chatId: string; key: string }
    | { type: 'clear_draft_attachments'; chatId: string }
    | { type: 'put_message'; message: HydratedStoredMessage }
    | { type: 'delete_message'; chatId: string; messageId: string }
    | { type: 'delete_messages_after'; chatId: string; lastKeptId: string }
    | { type: 'delete_chat'; chatId: string; sourceTabId?: string }
    | { type: 'load_chat_metas' }
    | { type: 'load_chats_by_ids'; ids: string[] }
    | { type: 'load_chat'; chatId: string }
    | { type: 'load_openrouter_models' }
    | { type: 'get_file_blob'; hash: string }
    | { type: 'file_status'; hashes: string[]; provider: string }
    | { type: 'list_local_files' }
    | { type: 'list_provider_files'; provider: string }
    | {
          type: 'delete_stored_file';
          target: FileDeleteTarget;
          sourceTabId: string;
      }
    | { type: 'get_storage_usage' }
    | { type: 'clear_chats'; sourceTabId?: string }
    | { type: 'clear_all'; sourceTabId?: string };

export interface StorageUsage {
    localSettingsBytes: number;
    openRouterCacheBytes: number;
    syncSettingsBytes: number;
    chatHistoryBytes: number;
    filesBytes: number;
}

export type StorageResponse =
    | { type: 'saved'; warning?: string }
    | { type: 'has_keys'; saved: Record<string, boolean> }
    | { type: 'key_test'; ok: boolean; message?: string }
    | { type: 'settings'; settings: Partial<UserSettings> }
    | { type: 'chat_metas'; metas: ChatMeta[] }
    | { type: 'chats'; chats: StoredChat[] }
    | { type: 'chat'; chat: StoredChat | null }
    | { type: 'openrouter_models'; models: OpenRouterModel[] | null }
    | {
          type: 'file_blob';
          blob: { mediaType: string; base64: string } | null;
      }
    | { type: 'file_status'; statuses: Record<string, FileAvailability> }
    | { type: 'local_files'; files: LocalFileInfo[] }
    | { type: 'provider_files'; files: ProviderFileInfo[] }
    | { type: 'stored_file_deleted'; chatIds: string[] }
    | ({ type: 'storage_usage' } & StorageUsage)
    | { type: 'error'; message: string };
