import type { Attachment, CourierUIMessage } from '@courier/shared';

// Re-exported here for ergonomic imports across the lib.
export type Message = CourierUIMessage;

export interface Chat {
    id: string;
    title: string;
    messages: CourierUIMessage[];
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
    // hash. Populated on send and consumed by put_message to ship bytes into
    // the ext's files store inline with the user-message put. Cleared on
    // successful turn completion; preserved through stream errors so retry
    // can re-submit without re-uploading.
    pendingBlobs?: Map<string, Attachment>;
    // Per-stream text accumulator written by the reducer during streaming.
    // Mirrors `messageText(<assistant placeholder>)` for the active turn so
    // ChatPanel's smooth-text effect can read it as O(1) instead of joining
    // all text parts every chunk. null between streams; readers fall back to
    // messageText(last) when null. Owned end-to-end by the reducer + the
    // stream-start / stream-finish helpers in chatStore.
    streamingText?: string | null;
}

export interface SearchResult {
    id: string;
    title: string;
    snippet: string;
    matchIndex: number | null;
}

// Concatenated text across every TextUIPart in render order. Used by
// search/snippet/copy and as the smoothText input for the streaming
// assistant turn.
export function messageText(msg: CourierUIMessage): string {
    return msg.parts
        .filter(
            (p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text'
        )
        .map((p) => p.text)
        .join('');
}

// Concatenated reasoning text across every ReasoningUIPart. Drives the
// expandable "Thinking" section.
export function messageThinking(msg: CourierUIMessage): string {
    return msg.parts
        .filter(
            (p): p is Extract<typeof p, { type: 'reasoning' }> =>
                p.type === 'reasoning'
        )
        .map((p) => p.text)
        .join('');
}

// Truncate a message's text content (across all text parts, in render order)
// to at most `maxChars`. Mutates parts in place so Svelte's $state proxy
// notifies. Used by the stop flow: source tab + mirror tabs snap to the
// visible character count at click time so the saved + displayed text match.
// Parts past the cut are dropped; the boundary text part is sliced and
// marked state:'done'. Non-text parts before the cut are kept.
export function truncateMessageTextParts(
    msg: CourierUIMessage,
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

// Flattens every `data-attachment` part to its ref shape for chip rendering.
// Order matches the part order in the message.
export function messageAttachments(
    msg: CourierUIMessage
): Array<{ hash: string; name: string; mediaType: string; sizeBytes: number }> {
    const out: Array<{
        hash: string;
        name: string;
        mediaType: string;
        sizeBytes: number;
    }> = [];
    for (const part of msg.parts) {
        if (part.type === 'data-attachment') {
            // The SDK's part union widens `data` to unknown; narrow via
            // the CourierDataParts shape.
            out.push(
                part.data as {
                    hash: string;
                    name: string;
                    mediaType: string;
                    sizeBytes: number;
                }
            );
        }
    }
    return out;
}
