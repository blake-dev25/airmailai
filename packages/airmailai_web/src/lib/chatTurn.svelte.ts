import type { AirmailAIChunk, AirmailAIMessage } from '@airmailai/shared';
import {
    createMessageAssembler,
    truncateMessageTextParts,
} from '@airmailai/shared';
import type { StreamHandle } from './extension';
import { createStreamBatcher, type StreamBatcher } from './streamBatcher';
import { messageText, type Chat } from './types';

export class StreamPipeline {
    text = $state('');
    readonly chat: Chat;
    readonly message: AirmailAIMessage;
    private readonly batcher: StreamBatcher;

    constructor(chat: Chat, message: AirmailAIMessage) {
        this.chat = chat;
        this.message = message;
        this.batcher = createStreamBatcher(
            createMessageAssembler(message),
            (delta) => {
                this.text += delta;
            }
        );
    }

    push(chunk: AirmailAIChunk): void {
        this.batcher.push(chunk);
    }

    flush(): void {
        this.batcher.flush();
    }

    truncate(visibleChars: number): void {
        this.batcher.discard();
        truncateMessageTextParts(this.message, visibleChars);
        this.text = messageText(this.message);
    }
}

export type TurnState =
    | { kind: 'preparing'; stopRequested: boolean }
    | {
          kind: 'local-streaming';
          handle: StreamHandle;
          pipeline: StreamPipeline;
      }
    | { kind: 'remote-streaming'; pipeline: StreamPipeline }
    | { kind: 'remote-joined-midway' }
    | { kind: 'failed'; message: string };

export function isTurnBusy(turn: TurnState | undefined): boolean {
    return turn !== undefined && turn.kind !== 'failed';
}

export function isTurnRemote(
    turn: TurnState | undefined
): turn is Extract<
    TurnState,
    { kind: 'remote-streaming' | 'remote-joined-midway' }
> {
    return (
        turn?.kind === 'remote-streaming' ||
        turn?.kind === 'remote-joined-midway'
    );
}
