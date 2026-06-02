import type {
    CourierAIChunk,
    CourierAIMessage,
    CourierAIMessageMetadata,
    CourierAIPart,
    CourierAIReasoningPart,
    CourierAITextPart,
    CourierAIToolPart,
} from './messages';

// Folds a CourierAIChunk stream into a CourierAIMessage's ordered parts. Pure
// in-place mutation: the ext assembles into a plain object to persist; the web
// drives the same fold over a $state proxy so fine-grained
// reactivity updates only the touched leaf. Maps track the open part per id so
// deltas land on the right segment and interleaving is preserved.
export interface MessageAssemblerState {
    message: CourierAIMessage;
    textById: Map<string, CourierAITextPart>;
    reasoningById: Map<string, CourierAIReasoningPart>;
    toolById: Map<string, CourierAIToolPart>;
}

export function createMessageAssembler(
    message: CourierAIMessage
): MessageAssemblerState {
    return {
        message,
        textById: new Map(),
        reasoningById: new Map(),
        toolById: new Map(),
    };
}

// Push a part and return the array's stored entry. When parts is a $state
// proxy the pushed literal is copied into a proxy, so returning the array slot
// (not the literal) keeps later in-place mutation reactive on the web.
function pushPart<T extends CourierAIPart>(
    state: MessageAssemblerState,
    part: T
): T {
    state.message.parts.push(part);
    return state.message.parts[state.message.parts.length - 1] as T;
}

function mergeMetadata(
    state: MessageAssemblerState,
    metadata: Partial<CourierAIMessageMetadata>
): void {
    state.message.metadata = { ...state.message.metadata, ...metadata };
}

export function applyCourierAIChunk(
    state: MessageAssemblerState,
    chunk: CourierAIChunk
): void {
    switch (chunk.type) {
        case 'text-start': {
            const part = pushPart<CourierAITextPart>(state, {
                type: 'text',
                text: '',
                state: 'streaming',
            });
            state.textById.set(chunk.id, part);
            break;
        }
        case 'text-delta': {
            const part = state.textById.get(chunk.id);
            if (part) part.text += chunk.delta;
            break;
        }
        case 'text-end': {
            const part = state.textById.get(chunk.id);
            if (part) part.state = 'done';
            state.textById.delete(chunk.id);
            break;
        }
        case 'reasoning-start': {
            const part = pushPart<CourierAIReasoningPart>(state, {
                type: 'reasoning',
                text: '',
                state: 'streaming',
            });
            state.reasoningById.set(chunk.id, part);
            break;
        }
        case 'reasoning-delta': {
            const part = state.reasoningById.get(chunk.id);
            if (part) part.text += chunk.delta;
            break;
        }
        case 'reasoning-end': {
            const part = state.reasoningById.get(chunk.id);
            if (part) {
                part.state = 'done';
                if (chunk.providerMetadata)
                    part.providerMetadata = chunk.providerMetadata;
            }
            state.reasoningById.delete(chunk.id);
            break;
        }
        case 'tool-call': {
            // chunk.name and chunk.input correlate (same chunk), but TS can't
            // track that across the union, so assert the part shape once here.
            const part = pushPart(state, {
                type: 'tool',
                toolCallId: chunk.toolCallId,
                name: chunk.name,
                state: 'running',
                ...(chunk.input ? { input: chunk.input } : {}),
            } as CourierAIToolPart);
            state.toolById.set(chunk.toolCallId, part);
            break;
        }
        case 'tool-result': {
            const part = state.toolById.get(chunk.toolCallId);
            if (part) {
                part.state = chunk.errorText ? 'error' : 'done';
                if (chunk.errorText) part.errorText = chunk.errorText;
                if (chunk.output && part.name === 'code_execution') {
                    part.output = chunk.output;
                }
            }
            break;
        }
        case 'source-url': {
            pushPart(state, {
                type: 'source-url',
                sourceId: chunk.sourceId,
                url: chunk.url,
                ...(chunk.title ? { title: chunk.title } : {}),
                ...(chunk.providerMetadata
                    ? { providerMetadata: chunk.providerMetadata }
                    : {}),
            });
            break;
        }
        case 'source-document': {
            pushPart(state, {
                type: 'source-document',
                sourceId: chunk.sourceId,
                ...(chunk.title ? { title: chunk.title } : {}),
                ...(chunk.mediaType ? { mediaType: chunk.mediaType } : {}),
                ...(chunk.citedText ? { citedText: chunk.citedText } : {}),
                ...(chunk.location ? { location: chunk.location } : {}),
                ...(chunk.providerMetadata
                    ? { providerMetadata: chunk.providerMetadata }
                    : {}),
            });
            break;
        }
        case 'file': {
            pushPart(state, {
                type: 'file',
                mediaType: chunk.mediaType,
                url: chunk.url,
                ...(chunk.filename ? { filename: chunk.filename } : {}),
                ...(chunk.providerMetadata
                    ? { providerMetadata: chunk.providerMetadata }
                    : {}),
            });
            break;
        }
        case 'start': {
            if (chunk.messageId) state.message.id = chunk.messageId;
            if (chunk.metadata) mergeMetadata(state, chunk.metadata);
            break;
        }
        case 'finish': {
            if (chunk.metadata) mergeMetadata(state, chunk.metadata);
            break;
        }
    }
}
