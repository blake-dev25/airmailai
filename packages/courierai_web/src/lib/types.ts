import type { Attachment, AttachmentRef, ToolResult } from '@courier/shared';

export interface Message {
    // Client-only stable identity. Drives keyed {#each} and per-message UI
    // state (edit/hover/expanded). Not persisted — regenerated on every load
    // from storage (see hydrateStoredMessages in App.svelte).
    id: string;
    role: 'user' | 'assistant';
    content: string;
    thinking?: string;
    attachments?: AttachmentRef[];
    toolResults?: ToolResult[];
}

export interface Chat {
    id: string;
    title: string;
    messages: Message[];
    createdAt: number;
    systemPrompt: string;
    providerId: string;
    modelId: string;
    temperature: number;
    maxTokens: number;
    thinkingLevel: string;
    adaptiveThinking: boolean;
    webSearch: boolean;
    tokens?: { input: number; output: number };
    // Fresh upload bytes that haven't yet been persisted by the ext, keyed by
    // hash. Populated on send and consumed by streamForChat to inline data
    // into the turn request. Cleared on successful turn completion; preserved
    // through stream errors so retry can re-submit without re-uploading.
    pendingBlobs?: Map<string, Attachment>;
}

export interface SearchResult {
    id: string;
    title: string;
    snippet: string;
    matchIndex: number | null;
}
