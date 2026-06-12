import type { CourierAIMessage, DraftAttachment } from '@courierai/shared';

export type Message = CourierAIMessage;

export interface Chat {
    id: string;
    title: string;
    messages: CourierAIMessage[];
    createdAt: number;
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

export function messageText(msg: CourierAIMessage): string {
    return msg.parts
        .filter(
            (p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text'
        )
        .map((p) => p.text)
        .join('');
}

export function messageThinking(msg: CourierAIMessage): string {
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
    msg: CourierAIMessage
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

export function truncateMessageTextParts(
    msg: CourierAIMessage,
    maxChars: number
): void {
    let textConsumed = 0;
    let i = 0;
    while (i < msg.parts.length) {
        const part = msg.parts[i];
        if (part.type === 'text') {
            const remaining = maxChars - textConsumed;
            if (remaining <= 0) {
                msg.parts.splice(i);
                return;
            }
            if (part.text.length > remaining) {
                part.text = part.text.slice(0, remaining);
                part.state = 'done';
                msg.parts.splice(i + 1);
                return;
            }
            textConsumed += part.text.length;
        }
        i++;
    }
}
