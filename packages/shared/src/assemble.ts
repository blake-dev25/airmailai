import type {
    AirmailAIChunk,
    AirmailAIGoogleSearchSuggestionsPart,
    AirmailAIMessage,
    AirmailAIMessageMetadata,
    AirmailAIPart,
    AirmailAIReasoningPart,
    AirmailAITextPart,
    AirmailAIToolPart,
} from './messages';

export interface MessageAssemblerState {
    message: AirmailAIMessage;
    textById: Map<string, AirmailAITextPart>;
    textInfoById: Map<string, { part: AirmailAITextPart; textIndex: number }>;
    reasoningById: Map<string, AirmailAIReasoningPart>;
    toolById: Map<string, AirmailAIToolPart>;
    sourceIds: Set<string>;
}

export function createMessageAssembler(
    message: AirmailAIMessage
): MessageAssemblerState {
    return {
        message,
        textById: new Map(),
        textInfoById: new Map(),
        reasoningById: new Map(),
        toolById: new Map(),
        sourceIds: new Set(),
    };
}

function pushPart<T extends AirmailAIPart>(
    state: MessageAssemblerState,
    part: T
): T {
    state.message.parts.push(part);
    return state.message.parts[state.message.parts.length - 1] as T;
}

function mergeMetadata(
    state: MessageAssemblerState,
    metadata: Partial<AirmailAIMessageMetadata>
): void {
    state.message.metadata = { ...state.message.metadata, ...metadata };
}

export function applyAirmailAIChunk(
    state: MessageAssemblerState,
    chunk: AirmailAIChunk
): void {
    switch (chunk.type) {
        case 'text-start': {
            const part = pushPart<AirmailAITextPart>(state, {
                type: 'text',
                text: '',
                state: 'streaming',
            });
            state.textById.set(chunk.id, part);
            state.textInfoById.set(chunk.id, {
                part,
                textIndex: state.textInfoById.size,
            });
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
            const part = pushPart<AirmailAIReasoningPart>(state, {
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
            if (part) part.state = 'done';
            state.reasoningById.delete(chunk.id);
            break;
        }
        case 'tool-call': {
            const part = pushPart(state, {
                type: 'tool',
                toolCallId: chunk.toolCallId,
                name: chunk.name,
                state: 'running',
                ...(chunk.input ? { input: chunk.input } : {}),
            } as AirmailAIToolPart);
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
            if (state.sourceIds.has(chunk.sourceId)) break;
            state.sourceIds.add(chunk.sourceId);
            pushPart(state, {
                type: 'source-url',
                sourceId: chunk.sourceId,
                url: chunk.url,
                ...(chunk.title ? { title: chunk.title } : {}),
            });
            break;
        }
        case 'source-document': {
            if (state.sourceIds.has(chunk.sourceId)) break;
            state.sourceIds.add(chunk.sourceId);
            pushPart(state, {
                type: 'source-document',
                sourceId: chunk.sourceId,
                ...(chunk.title ? { title: chunk.title } : {}),
                ...(chunk.mediaType ? { mediaType: chunk.mediaType } : {}),
                ...(chunk.hash ? { hash: chunk.hash } : {}),
            });
            break;
        }
        case 'citation': {
            const info = state.textInfoById.get(chunk.textId);
            if (!info) break;
            pushPart(state, {
                type: 'citation',
                sourceId: chunk.sourceId,
                textIndex: info.textIndex,
                textEnd: chunk.textEnd ?? -1,
                ...(chunk.textStart !== undefined
                    ? { textStart: chunk.textStart }
                    : {}),
                ...(chunk.citedText ? { citedText: chunk.citedText } : {}),
                ...(chunk.location ? { location: chunk.location } : {}),
            });
            break;
        }
        case 'google-search-suggestions': {
            const existing = state.message.parts.find(
                (p): p is AirmailAIGoogleSearchSuggestionsPart =>
                    p.type === 'google-search-suggestions'
            );
            if (existing) existing.html = chunk.html;
            else {
                pushPart(state, {
                    type: 'google-search-suggestions',
                    html: chunk.html,
                });
            }
            break;
        }
        case 'file': {
            pushPart(state, {
                type: 'file',
                filename: chunk.filename,
                mediaType: chunk.mediaType,
                sizeBytes: chunk.sizeBytes,
                hash: chunk.hash,
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
