import type { AirmailAIMessage, DraftAttachment } from '@airmailai/shared';

export type Message = AirmailAIMessage;

export interface Chat {
    id: string;
    title: string;
    messages: AirmailAIMessage[];
    messagesLoaded: boolean;
    createdAt: number;
    lastMessageAt?: number;
    revision?: number;
    systemPrompt: string;
    providerId: string;
    modelId: string;
    temperature: number;
    maxTokens: number;
    thinkingLevel: string;
    adaptiveThinking: boolean;
    webSearch: boolean;
    webFetch: boolean;
    codeExecution: boolean;
    draftAttachments?: DraftAttachment[];
    streamingText?: string | null;
}

export interface SearchResult {
    id: string;
    title: string;
    snippet: string;
    matchIndex: number | null;
}

export function messageText(msg: AirmailAIMessage): string {
    return msg.parts
        .filter(
            (p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text'
        )
        .map((p) => p.text)
        .join('');
}

export function messageThinking(msg: AirmailAIMessage): string {
    return msg.parts
        .filter(
            (p): p is Extract<typeof p, { type: 'reasoning' }> =>
                p.type === 'reasoning'
        )
        .map((p) => p.text)
        .join('');
}

export interface CodeExecutionView {
    id: string;
    code?: string;
    stdout?: string;
    stderr?: string;
    state: 'running' | 'done' | 'error';
    errorText?: string;
}

export function messageCodeExecutions(
    msg: AirmailAIMessage
): CodeExecutionView[] {
    const out: CodeExecutionView[] = [];
    for (const part of msg.parts) {
        if (part.type === 'tool' && part.name === 'code_execution') {
            out.push({
                id: part.toolCallId,
                code: part.input?.code,
                stdout: part.output?.stdout,
                stderr: part.output?.stderr,
                state: part.state,
                errorText: part.errorText,
            });
        }
    }
    return out;
}
