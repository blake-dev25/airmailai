import type { Attachment, AttachmentRef, ToolResult } from '@courier/shared';

export interface Message {
    // Stable, persistent identity. Persisted to IDB as the primary key
    // alongside chatId; drives keyed {#each} and per-message UI state
    // (edit/hover/expanded) on the web side. Assigned at message creation.
    id: string;
    // Drives load-order via a compound IDB index. Set at message creation;
    // never mutated.
    createdAt: number;
    role: 'user' | 'assistant';
    content: string;
    thinking?: string;
    attachments?: AttachmentRef[];
    toolResults?: ToolResult[];
    tokens?: { input: number; output: number };
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
