// Persisted form. Carries everything needed to render an attachment chip and
// look up the bytes by content-hash. Storage lives in the ext's `files` IDB
// store keyed by `hash`, dedup'd via refCount across chats.
export interface AttachmentRef {
    hash: string; // SHA-256 of raw bytes
    name: string;
    mediaType: string;
    sizeBytes: number;
}

// In-flight form. Adds the base64-encoded bytes used by fresh uploads. Bytes
// flow web -> ext only on put_message - once stored in the files store, only
// the ref travels.
export interface Attachment extends AttachmentRef {
    encodedSizeBytes: number;
    data: string; // base64
}

// Metadata carried on every CourierAIMessage. `createdAt` drives load-order
// in IDB (compound index reaches into message.metadata.createdAt) and is
// also surfaced in the UI. `tokens` lands on assistant messages once usage
// is reported and feeds the footer/header indicators.
export interface CourierAIMessageMetadata {
    createdAt: number;
    tokens?: { input: number; output: number };
    // Normalized finish reason. Refusals fold into a text part + this flag
    // rather than a dedicated part (each provider spells refusal differently;
    // we map them all to 'refusal').
    stopReason?: 'stop' | 'length' | 'refusal' | 'content-filter' | 'error';
}

// ============================================================================
// OWNED STREAMING PROTOCOL (re-derived from provider response schemas)
// ----------------------------------------------------------------------------
// Built UP from what Anthropic / OpenAI / Google / OpenRouter actually emit,
// NOT trimmed down from a generic SDK message type. Decontamination rule:
// every type/field traces to a provider API or a product need.
// ============================================================================

// Provider-namespaced opaque metadata (our replacement for `ai`'s
// ProviderMetadata). Outer key = provider id ('anthropic'); inner = that
// provider's blob. Carries replay-critical bits we cannot re-derive: Anthropic
// thinking `signature` + web_search_result `encrypted_content`, Google
// `thoughtSignature`. (OpenAI reasoning is NOT replayed - store:false + the
// Sources text-fold, see plan D3.)
export type CourierAIProviderMetadata = Record<string, Record<string, unknown>>;

// The server-executed tools we support. CLOSED on purpose - no open
// `tool-${string}` generic (that's what forced the cast sites in the old
// reducer). Adding a tool = extend this union + the tool part/chunk below.
export type CourierAIToolName = 'web_search' | 'web_fetch' | 'code_execution';

// An assistant/user message is an ORDERED list of these. Order is the point -
// it preserves reasoning <-> text <-> tool interleave in render order.
export type CourierAIPart =
    | CourierAITextPart
    | CourierAIReasoningPart
    | CourierAIToolPart
    | CourierAISourceUrlPart
    | CourierAISourceDocumentPart
    | CourierAIFilePart
    | CourierAIDataAttachmentPart;

export interface CourierAITextPart {
    type: 'text';
    text: string;
    state: 'streaming' | 'done';
}

// thinking / reasoning summary. providerMetadata carries the replay token the
// producing provider needs to re-send this on a later turn: anthropic.signature
// (ThinkingBlock), google.thoughtSignature.
export interface CourierAIReasoningPart {
    type: 'reasoning';
    text: string;
    state: 'streaming' | 'done';
    providerMetadata?: CourierAIProviderMetadata;
}

// A server tool invocation, discriminated by `name` so input/output type per
// tool with no casts. web_search emits its results as separate source-url
// parts (not in `output`); code_execution emits produced images/files as
// separate file parts.
type CourierAIToolPartBase = {
    type: 'tool';
    toolCallId: string;
    state: 'running' | 'done' | 'error';
    errorText?: string;
    providerMetadata?: CourierAIProviderMetadata;
};
export type CourierAIToolPart =
    | (CourierAIToolPartBase & {
          name: 'web_search';
          input?: { query?: string };
      })
    | (CourierAIToolPartBase & { name: 'web_fetch'; input?: { url?: string } })
    | (CourierAIToolPartBase & {
          name: 'code_execution';
          input?: { code?: string };
          output?: { stdout?: string; stderr?: string };
      });

// Web-search citation. providerMetadata.anthropic.encrypted_content carries the
// blob Anthropic needs to round-trip the result natively; for OpenAI/Google/
// OpenRouter url+title suffice (replay is the Sources text-fold).
export interface CourierAISourceUrlPart {
    type: 'source-url';
    sourceId: string;
    url: string;
    title?: string;
    providerMetadata?: CourierAIProviderMetadata;
}

// Document/PDF citation (Anthropic CitationPageLocation/CharLocation, OpenAI
// file_citation). citedText + location are what make these richer than a URL.
export interface CourierAISourceDocumentPart {
    type: 'source-document';
    sourceId: string;
    title?: string;
    mediaType?: string;
    citedText?: string;
    location?: { kind: 'page' | 'char'; start: number; end: number };
    providerMetadata?: CourierAIProviderMetadata;
}

// Assistant-produced file/image (code-execution output, inline image data).
// `url` is a remote URL or a data: URL the ext inlines.
export interface CourierAIFilePart {
    type: 'file';
    mediaType: string;
    url: string;
    filename?: string;
    providerMetadata?: CourierAIProviderMetadata;
}

// Our own part (no provider emits this): a content-addressed user upload whose
// bytes live in the ext files store, looked up by hash on the way to a provider.
export interface CourierAIDataAttachmentPart {
    type: 'data-attachment';
    id?: string;
    data: {
        hash: string;
        name: string;
        mediaType: string;
        sizeBytes: number;
    };
}

// A full message - an ordered list of parts + metadata. System prompt is
// carried separately (TurnStartRequest.system), so role is user|assistant here.
export interface CourierAIMessage {
    id: string;
    role: 'user' | 'assistant';
    parts: CourierAIPart[];
    metadata: CourierAIMessageMetadata;
}

// The streaming deltas the ext emits and the web folds into parts. start/delta/
// end + id is the interleave mechanism; everything else is atomic (server tools
// + citations arrive whole). error/abort are NOT here - they ride the port
// envelope (ExtensionStreamEvent). No step boundaries - that was the SDK's
// agent-loop concept; our server tools run inside one provider response.
export type CourierAIChunk =
    | { type: 'text-start'; id: string }
    | { type: 'text-delta'; id: string; delta: string }
    | { type: 'text-end'; id: string }
    | { type: 'reasoning-start'; id: string }
    | { type: 'reasoning-delta'; id: string; delta: string }
    | {
          type: 'reasoning-end';
          id: string;
          providerMetadata?: CourierAIProviderMetadata;
      }
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
          providerMetadata?: CourierAIProviderMetadata;
      }
    | {
          type: 'source-document';
          sourceId: string;
          title?: string;
          mediaType?: string;
          citedText?: string;
          location?: { kind: 'page' | 'char'; start: number; end: number };
          providerMetadata?: CourierAIProviderMetadata;
      }
    | {
          type: 'file';
          mediaType: string;
          url: string;
          filename?: string;
          providerMetadata?: CourierAIProviderMetadata;
      }
    | {
          type: 'start';
          messageId?: string;
          metadata?: Partial<CourierAIMessageMetadata>;
      }
    | { type: 'finish'; metadata?: Partial<CourierAIMessageMetadata> };

// Provider stream contract. Each provider builds its request from
// CourierAIMessage[], opens the SSE, and maps provider events to our chunk
// vocabulary; background.ts pumps the iterator. createdAt is set by the
// message producer, so provider chunks carry only partial metadata
// (tokens/stopReason).
export interface ProviderStreamArgs {
    apiKey: string;
    model: string;
    messages: CourierAIMessage[];
    system?: string;
    params: Record<string, unknown>;
    signal?: AbortSignal;
}
export type ProviderStream = (
    args: ProviderStreamArgs
) => AsyncIterable<CourierAIChunk>;

// Persisted form. One IDB row per message, keyPath `['chatId', 'message.id']`,
// ordered by index `['chatId', 'message.metadata.createdAt', 'message.id']`.
export interface StoredMessage {
    chatId: string;
    message: CourierAIMessage;
}

// In-flight form sent from web -> ext via put_message. `freshBlobs` carries
// the base64 bytes for any new `data-attachment` parts whose hash isn't yet
// in the files store. The ext extracts them into the files store and
// persists the message with bare refs. Map keys are the attachment hashes.
export interface HydratedStoredMessage {
    chatId: string;
    message: CourierAIMessage;
    freshBlobs?: Record<string, { mediaType: string; base64: string }>;
}

// Sent over a port (chrome.runtime.connect) for streaming chat. The 'start'
// message kicks off a turn; the extension owns the turn lifecycle from here
// (lock, stream, append-assistant-message-on-completion). The web can send
// 'stop' mid-stream with `truncateTo` = the visible character count at the
// moment of click; the ext truncates the assembled assistant message to that
// many text chars before saving so the saved row matches what the user saw.
//
// `history` is the pre-turn message state used ONLY for cross-tab broadcast
// (so mirror tabs can render the chat instantly). The extension does NOT
// persist it - user messages and edits are the web's responsibility (via
// put_message / save_meta / etc), the terminal save just appends one new
// assistant row.
export interface TurnStartRequest {
    type: 'start';
    chatId: string;
    sourceTabId: string;
    provider: string;
    model: string;
    // Chat history WITHOUT the trailing assistant placeholder. All
    // `data-attachment` parts must reference hashes already in the ext's
    // files store (the web persists the user message + bytes before
    // sending this request).
    messages: CourierAIMessage[];
    // Optional system prompt, carried separately from the message list.
    system?: string;
    params?: Record<string, unknown>;
    meta: ChatMeta;
    history: StoredMessage[];
    // Stable id for the assistant message the terminal save will append.
    // Generated by the web so it can render the in-progress placeholder
    // under the same id that eventually lands in IDB.
    assistantMessageId: string;
}

export interface TurnStopRequest {
    type: 'stop';
    // Visible text character count at the moment the user clicked stop. The
    // ext truncates the assembled assistant message's text parts to this many
    // chars (in render order) before saving, so what gets persisted matches
    // what the user saw. Parts past the cut are dropped.
    truncateTo: number;
}

export type TurnRequest = TurnStartRequest | TurnStopRequest;

export type StreamErrorSource = 'api' | 'extension';

// Sent from ext -> source tab over the turn port. CourierAIChunk values pass
// through verbatim as `chunk` events - that's the wire protocol. Errors never
// ride as chunks; they surface as the `error` event below, with `source`
// attributing them to the ext (pre-stream: no API key, hydrate failure) or
// the API (in-stream).
export type ExtensionStreamEvent =
    | { type: 'chunk'; chunk: CourierAIChunk }
    | { type: 'done' }
    | { type: 'error'; source: StreamErrorSource; message: string };

// Sent on the long-lived 'broadcast' port from the extension to every
// connected tab so tabs can mirror cross-tab turn lifecycle. The extension
// skips the source tab server-side (each broadcast port is tagged with its
// sourceTabId via the 'register' message), so events arrive only at mirror
// tabs.
export type BroadcastEvent =
    | {
          type: 'turn-start';
          chatId: string;
          sourceTabId: string;
          meta: ChatMeta;
          history: StoredMessage[];
          assistantMessageId: string;
      }
    | {
          type: 'turn-chunk';
          chatId: string;
          chunk: CourierAIChunk;
      }
    | { type: 'turn-done'; chatId: string }
    | { type: 'turn-error'; chatId: string; message: string }
    | { type: 'turn-aborted'; chatId: string }
    // Sent immediately after a stop, before turn-done. Mirror tabs snap their
    // assistant placeholder's text parts to `charLen` so every tab shows the
    // same final text - without this, mirror tabs would display all the
    // chunks that arrived before stop and then visibly shrink on the IDB
    // refresh that turn-done triggers.
    | { type: 'turn-truncate'; chatId: string; charLen: number };

// Sent from each connected tab over the broadcast port.
//   - 'register' tags the port with the web's sourceTabId so the extension
//     can skip the source tab when fanning out turn-* events. Single-tab
//     case turns every broadcast into a noop. Sent once, immediately after
//     the port opens.
//   - 'keepalive' is a global heartbeat: as long as any tab has the website
//     open, it resets the SW's 30s idle timer so the worker stays warm for
//     cross-tab fan-out and the next turn.
export interface BroadcastRegisterRequest {
    type: 'register';
    sourceTabId: string;
}
export interface BroadcastKeepaliveRequest {
    type: 'keepalive';
}
export type BroadcastRequest =
    | BroadcastRegisterRequest
    | BroadcastKeepaliveRequest;

export interface UserSettings {
    theme: string;
    fontSizeIndex: number;
    chatWidth: number;
    smoothTextMode: 'smooth' | 'boost-on-complete' | 'dump-on-complete' | 'raw';
    submitKeystroke: 'enter' | 'ctrl+enter';
    modelTier: 'latest' | 'previous' | 'legacy';
    autoscrollMode: 'pin-user-message' | 'pin-bottom' | 'off';
    // Master toggles in Advanced settings. Gate whether the corresponding
    // per-chat tool toggle is rendered in ModelConfig at all.
    enableWebSearch: boolean;
    enableWebFetch: boolean;
    enableCodeExecution: boolean;
    providerId: string;
    modelId: string;
    temperature: number;
    maxTokens: number;
    thinkingLevel: string;
    adaptiveThinking: boolean;
    // Per-chat tool toggles (also act as defaults for new chats).
    webSearch: boolean;
    webFetch: boolean;
    codeExecution: boolean;
    tagOpenRouterRequests: boolean;
    // Content hash of the last accepted ToS/Privacy pair. Empty/missing = never agreed.
    legalAcceptedVersion: string;
}

// The mapped-type constraint forces every UserSettings field to appear here -
// adding a field to UserSettings without listing it here is a compile error.
const SETTINGS_KEY_MAP: { [K in keyof UserSettings]: 0 } = {
    theme: 0,
    fontSizeIndex: 0,
    chatWidth: 0,
    smoothTextMode: 0,
    submitKeystroke: 0,
    modelTier: 0,
    autoscrollMode: 0,
    enableWebSearch: 0,
    enableWebFetch: 0,
    enableCodeExecution: 0,
    providerId: 0,
    modelId: 0,
    temperature: 0,
    maxTokens: 0,
    thinkingLevel: 0,
    adaptiveThinking: 0,
    webSearch: 0,
    webFetch: 0,
    codeExecution: 0,
    tagOpenRouterRequests: 0,
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
    webFetch: boolean;
    codeExecution: boolean;
    systemPrompt: string;
}

// All messages for one chat, in load order. Meta is loaded separately via
// load_chat_metas.
export interface StoredChat {
    id: string;
    messages: StoredMessage[];
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

// Sent via chrome.runtime.sendMessage for one-off storage operations.
//
// Per-message granularity (put_message / delete_message / delete_messages_after)
// replaces the old blob-style save_chat - writes to disjoint rows don't race,
// so renames/edits/stream-finalize can interleave safely without locks.
export type StorageRequest =
    | { type: 'save_key'; provider: string; apiKey: string }
    | { type: 'clear_key'; provider: string }
    | { type: 'has_keys'; providers: string[] }
    | { type: 'save_settings'; settings: Partial<UserSettings> }
    | { type: 'load_settings' }
    | { type: 'save_meta'; meta: ChatMeta }
    | { type: 'put_message'; message: HydratedStoredMessage }
    | { type: 'delete_message'; chatId: string; messageId: string }
    | { type: 'delete_messages_after'; chatId: string; lastKeptId: string }
    | { type: 'delete_chat'; chatId: string }
    | { type: 'load_chat_metas' }
    | { type: 'load_chats' }
    | { type: 'load_chats_by_ids'; ids: string[] }
    | { type: 'load_chat'; chatId: string }
    | { type: 'load_openrouter_models' }
    | { type: 'get_storage_usage' }
    | { type: 'clear_chats' }
    | { type: 'clear_all' };

// Per-area byte counts shown in Settings -> Storage.
export interface StorageUsage {
    localSettingsBytes: number;
    openRouterCacheBytes: number;
    syncSettingsBytes: number;
    chatHistoryBytes: number;
    filesBytes: number;
}

export type StorageResponse =
    | { type: 'saved' }
    | { type: 'has_keys'; saved: Record<string, boolean> }
    | { type: 'settings'; settings: Partial<UserSettings> }
    | { type: 'chat_metas'; metas: ChatMeta[] }
    | { type: 'chats'; chats: StoredChat[] }
    | { type: 'chat'; chat: StoredChat | null }
    | { type: 'openrouter_models'; models: OpenRouterModel[] | null }
    | ({ type: 'storage_usage' } & StorageUsage)
    | { type: 'error'; message: string };
