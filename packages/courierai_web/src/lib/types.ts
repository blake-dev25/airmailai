import type { Attachment } from '@courier/shared';

export interface Message {
    role: 'user' | 'assistant';
    content: string;
    thinking?: string;
    attachments?: Attachment[];
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
    tokens?: { input: number; output: number };
}

export interface SearchResult {
    id: string;
    title: string;
    snippet: string;
    matchIndex: number | null;
}
