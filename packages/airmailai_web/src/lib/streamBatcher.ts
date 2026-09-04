import type { AirmailAIChunk, MessageAssemblerState } from '@airmailai/shared';
import { applyAirmailAIChunk } from '@airmailai/shared';
import type { Chat } from './types';

type DeltaChunk = Extract<
    AirmailAIChunk,
    { type: 'text-delta' | 'reasoning-delta' }
>;

export interface StreamBatcher {
    push(chunk: AirmailAIChunk): void;
    flush(): void;
    discard(): void;
}

export function createStreamBatcher(
    assembler: MessageAssemblerState,
    chat: Chat
): StreamBatcher {
    const pending = new Map<string, DeltaChunk>();
    let pendingText = '';
    let frame: number | null = null;

    function cancelFrame() {
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
    }

    function flush() {
        cancelFrame();
        if (pending.size === 0) return;
        for (const delta of pending.values()) {
            applyAirmailAIChunk(assembler, delta);
        }
        pending.clear();
        if (pendingText) {
            chat.streamingText = (chat.streamingText ?? '') + pendingText;
            pendingText = '';
        }
    }

    function push(chunk: AirmailAIChunk) {
        if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') {
            flush();
            applyAirmailAIChunk(assembler, chunk);
            return;
        }
        const key = `${chunk.type}:${chunk.id}`;
        const merged = pending.get(key);
        if (merged) merged.delta += chunk.delta;
        else pending.set(key, { ...chunk });
        if (chunk.type === 'text-delta') pendingText += chunk.delta;
        if (frame === null) frame = requestAnimationFrame(flush);
    }

    function discard() {
        cancelFrame();
        pending.clear();
        pendingText = '';
    }

    return { push, flush, discard };
}
