import type {
    ExtensionStreamEvent,
    MessageAssemblerState,
    TurnStartRequest,
} from '@airmailai/shared';
import { createMessageAssembler } from '@airmailai/shared';
import type { TurnLifecycle } from './turn-lifecycle';

export interface TurnSession {
    request: TurnStartRequest;
    lifecycle: TurnLifecycle;
    signal: AbortSignal;
    send: (event: ExtensionStreamEvent) => void;
}

export interface TurnProgress {
    assembler: MessageAssemblerState;
    chatRevision: number | null;
    apiKey: string | undefined;
    storageOn: boolean;
    container: { id: string; expiresAt: string | undefined } | null;
    outputBlobs: Map<string, Blob>;
    outputWarnings: string[];
}

export function createTurnProgress(request: TurnStartRequest): TurnProgress {
    return {
        assembler: createMessageAssembler({
            id: request.assistantMessageId,
            role: 'assistant',
            parts: [],
            metadata: { createdAt: request.assistantCreatedAt },
        }),
        chatRevision: null,
        apiKey: undefined,
        storageOn: false,
        container: null,
        outputBlobs: new Map(),
        outputWarnings: [],
    };
}
