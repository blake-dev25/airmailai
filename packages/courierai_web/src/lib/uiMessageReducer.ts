// In-house equivalent of AI SDK's `readUIMessageStream` reducer
// (ai/dist/index.mjs processUIMessageStream). The SDK's version is built
// for React: it deep-clones the entire message on every chunk via
// `structuredClone` so React sees a new reference and re-renders. With
// Svelte 5's fine-grained $state proxies we want the opposite — mutate the
// existing message's parts in place so only the changed property
// invalidates downstream readers.
//
// Two deviations from the SDK reducer worth knowing:
//
// 1. `tool-input-delta` does NOT call `parsePartialJson`. We don't render
//    in-flight tool inputs anywhere in the UI; we accumulate the raw delta
//    text into `partialToolCalls[id].text` and let `tool-input-available`
//    land the finalized input. If we ever surface live tool input
//    rendering, re-add the `parsePartialJson` call from `ai`.
//
// 2. A `streamingText` accumulator on state mirrors
//    `messageText(state.message)` after every chunk. ChatPanel reads this
//    directly to avoid the O(N²) per-chunk join that re-walking parts and
//    re-allocating the joined string would otherwise cost. Invariant
//    holds by construction: text-deltas land in render order, step-start
//    parts are non-text so contribute nothing on either side, and a new
//    text-start after finish-step pushes the next text part at the array
//    tail.

import type {
    ProviderMetadata,
    ReasoningUIPart,
    TextUIPart,
    UIMessageChunk,
} from 'ai';
import type { CourierUIMessage } from '@courier/shared';

interface PartialToolCall {
    toolName: string;
    dynamic: boolean;
    title: string | undefined;
    toolMetadata: Record<string, unknown> | undefined;
    text: string;
}

export interface UIMessageReducerState {
    message: CourierUIMessage;
    activeTextParts: Record<string, TextUIPart>;
    activeReasoningParts: Record<string, ReasoningUIPart>;
    partialToolCalls: Record<string, PartialToolCall>;
    streamingText: string;
}

export function createUIMessageReducer(
    message: CourierUIMessage
): UIMessageReducerState {
    return {
        message,
        activeTextParts: {},
        activeReasoningParts: {},
        partialToolCalls: {},
        streamingText: '',
    };
}

// Push a literal onto a $state-proxied array, then return the proxied entry
// from the array — mutations against the literal would bypass Svelte's
// proxy and silently miss reactivity. Always go through the returned ref.
// The bounded `T extends E` lets us push a narrower part type into a wider
// union-typed parts array while still returning that narrower type.
function pushAndCapture<E, T extends E>(arr: E[], item: T): T {
    arr.push(item);
    return arr[arr.length - 1] as T;
}

// Mutates `state.message` and the sidecar maps in place. Synchronous so
// callers can drive it directly from a port `onmessage` listener without
// awaiting per chunk.
export function applyChunk(
    state: UIMessageReducerState,
    chunk: UIMessageChunk
): void {
    switch (chunk.type) {
        case 'text-start': {
            const part: TextUIPart = {
                type: 'text',
                text: '',
                providerMetadata: chunk.providerMetadata,
                state: 'streaming',
            };
            state.activeTextParts[chunk.id] = pushAndCapture(
                state.message.parts,
                part
            );
            break;
        }
        case 'text-delta': {
            const part = state.activeTextParts[chunk.id];
            if (part == null) return;
            part.text += chunk.delta;
            if (chunk.providerMetadata) {
                part.providerMetadata = chunk.providerMetadata;
            }
            state.streamingText += chunk.delta;
            break;
        }
        case 'text-end': {
            const part = state.activeTextParts[chunk.id];
            if (part == null) return;
            part.state = 'done';
            if (chunk.providerMetadata) {
                part.providerMetadata = chunk.providerMetadata;
            }
            delete state.activeTextParts[chunk.id];
            break;
        }
        case 'reasoning-start': {
            const part: ReasoningUIPart = {
                type: 'reasoning',
                text: '',
                providerMetadata: chunk.providerMetadata,
                state: 'streaming',
            };
            state.activeReasoningParts[chunk.id] = pushAndCapture(
                state.message.parts,
                part
            );
            break;
        }
        case 'reasoning-delta': {
            const part = state.activeReasoningParts[chunk.id];
            if (part == null) return;
            part.text += chunk.delta;
            if (chunk.providerMetadata) {
                part.providerMetadata = chunk.providerMetadata;
            }
            break;
        }
        case 'reasoning-end': {
            const part = state.activeReasoningParts[chunk.id];
            if (part == null) return;
            part.state = 'done';
            if (chunk.providerMetadata) {
                part.providerMetadata = chunk.providerMetadata;
            }
            delete state.activeReasoningParts[chunk.id];
            break;
        }
        case 'file': {
            state.message.parts.push({
                type: 'file',
                mediaType: chunk.mediaType,
                url: chunk.url,
                ...(chunk.providerMetadata
                    ? { providerMetadata: chunk.providerMetadata }
                    : {}),
            });
            break;
        }
        case 'source-url': {
            state.message.parts.push({
                type: 'source-url',
                sourceId: chunk.sourceId,
                url: chunk.url,
                title: chunk.title,
                providerMetadata: chunk.providerMetadata,
            });
            break;
        }
        case 'source-document': {
            state.message.parts.push({
                type: 'source-document',
                sourceId: chunk.sourceId,
                mediaType: chunk.mediaType,
                title: chunk.title,
                filename: chunk.filename,
                providerMetadata: chunk.providerMetadata,
            });
            break;
        }
        case 'tool-input-start': {
            state.partialToolCalls[chunk.toolCallId] = {
                toolName: chunk.toolName,
                dynamic: !!chunk.dynamic,
                title: chunk.title,
                toolMetadata: chunk.toolMetadata,
                text: '',
            };
            upsertToolPart(state, {
                toolCallId: chunk.toolCallId,
                toolName: chunk.toolName,
                dynamic: !!chunk.dynamic,
                state: 'input-streaming',
                input: undefined,
                providerExecuted: chunk.providerExecuted,
                title: chunk.title,
                toolMetadata: chunk.toolMetadata,
                providerMetadata: chunk.providerMetadata,
            });
            break;
        }
        case 'tool-input-delta': {
            // Accumulate raw text only — we don't render in-flight inputs,
            // so the parsePartialJson dance in the SDK reducer is dead
            // weight here. tool-input-available will land the parsed input.
            const partial = state.partialToolCalls[chunk.toolCallId];
            if (partial == null) return;
            partial.text += chunk.inputTextDelta;
            break;
        }
        case 'tool-input-available': {
            upsertToolPart(state, {
                toolCallId: chunk.toolCallId,
                toolName: chunk.toolName,
                dynamic: !!chunk.dynamic,
                state: 'input-available',
                input: chunk.input,
                providerExecuted: chunk.providerExecuted,
                providerMetadata: chunk.providerMetadata,
                title: chunk.title,
                toolMetadata: chunk.toolMetadata,
            });
            break;
        }
        case 'tool-input-error': {
            const existing = findToolPart(state, chunk.toolCallId);
            const dynamic =
                existing != null
                    ? existing.type === 'dynamic-tool'
                    : !!chunk.dynamic;
            upsertToolPart(state, {
                toolCallId: chunk.toolCallId,
                toolName: chunk.toolName,
                dynamic,
                state: 'output-error',
                input: dynamic ? chunk.input : undefined,
                rawInput: dynamic ? undefined : chunk.input,
                errorText: chunk.errorText,
                providerExecuted: chunk.providerExecuted,
                providerMetadata: chunk.providerMetadata,
                toolMetadata: chunk.toolMetadata,
            });
            break;
        }
        case 'tool-approval-request': {
            const invocation = findToolPart(state, chunk.toolCallId);
            if (invocation == null) return;
            invocation.state = 'approval-requested';
            invocation.approval = { id: chunk.approvalId };
            break;
        }
        case 'tool-output-denied': {
            const invocation = findToolPart(state, chunk.toolCallId);
            if (invocation == null) return;
            invocation.state = 'output-denied';
            break;
        }
        case 'tool-output-available': {
            const invocation = findToolPart(state, chunk.toolCallId);
            if (invocation == null) return;
            const dynamic = invocation.type === 'dynamic-tool';
            upsertToolPart(state, {
                toolCallId: chunk.toolCallId,
                toolName: dynamic
                    ? ((invocation.toolName as string | undefined) ?? '')
                    : invocation.type.replace(/^tool-/, ''),
                dynamic,
                state: 'output-available',
                input: invocation.input,
                output: chunk.output,
                preliminary: chunk.preliminary,
                providerExecuted: chunk.providerExecuted,
                providerMetadata: chunk.providerMetadata,
                title: invocation.title as string | undefined,
                toolMetadata: invocation.toolMetadata as
                    | Record<string, unknown>
                    | undefined,
            });
            break;
        }
        case 'tool-output-error': {
            const invocation = findToolPart(state, chunk.toolCallId);
            if (invocation == null) return;
            const dynamic = invocation.type === 'dynamic-tool';
            upsertToolPart(state, {
                toolCallId: chunk.toolCallId,
                toolName: dynamic
                    ? ((invocation.toolName as string | undefined) ?? '')
                    : invocation.type.replace(/^tool-/, ''),
                dynamic,
                state: 'output-error',
                input: invocation.input,
                rawInput: dynamic ? undefined : invocation.rawInput,
                errorText: chunk.errorText,
                providerExecuted: chunk.providerExecuted,
                providerMetadata: chunk.providerMetadata,
                title: invocation.title as string | undefined,
                toolMetadata: invocation.toolMetadata as
                    | Record<string, unknown>
                    | undefined,
            });
            break;
        }
        case 'start-step': {
            state.message.parts.push({ type: 'step-start' });
            break;
        }
        case 'finish-step': {
            // Step boundary — subsequent text/reasoning chunks belong to a
            // fresh part with a new id, so clear the active maps. The
            // already-pushed parts stay in place; streamingText keeps
            // accumulating across steps (matches messageText's join-all).
            state.activeTextParts = {};
            state.activeReasoningParts = {};
            break;
        }
        case 'start': {
            if (chunk.messageId != null) {
                state.message.id = chunk.messageId;
            }
            if (chunk.messageMetadata != null) {
                mergeMessageMetadata(state, chunk.messageMetadata);
            }
            break;
        }
        case 'finish': {
            if (chunk.messageMetadata != null) {
                mergeMessageMetadata(state, chunk.messageMetadata);
            }
            break;
        }
        case 'message-metadata': {
            if (chunk.messageMetadata != null) {
                mergeMessageMetadata(state, chunk.messageMetadata);
            }
            break;
        }
        case 'error':
        case 'abort': {
            // Surfaced separately via the port envelope; nothing to mutate.
            break;
        }
        default: {
            if (
                typeof chunk.type === 'string' &&
                chunk.type.startsWith('data-')
            ) {
                handleDataChunk(state, chunk);
                return;
            }
            console.warn(
                '[courier:web] uiMessageReducer: unhandled chunk type',
                (chunk as { type: string }).type
            );
        }
    }
}

// --- Helpers ---

function mergeMessageMetadata(
    state: UIMessageReducerState,
    metadata: unknown
): void {
    const existing = state.message.metadata as unknown as
        | Record<string, unknown>
        | undefined;
    const next = metadata as Record<string, unknown>;
    const merged = existing != null ? { ...existing, ...next } : next;
    state.message.metadata = merged as unknown as CourierUIMessage['metadata'];
}

interface ToolPartOptions {
    toolCallId: string;
    toolName: string;
    dynamic: boolean;
    state:
        | 'input-streaming'
        | 'input-available'
        | 'output-available'
        | 'output-error'
        | 'output-denied'
        | 'approval-requested';
    input?: unknown;
    output?: unknown;
    rawInput?: unknown;
    errorText?: string;
    preliminary?: boolean;
    providerExecuted?: boolean;
    providerMetadata?: ProviderMetadata;
    title?: string;
    toolMetadata?: Record<string, unknown>;
}

// Find a tool part by toolCallId across both static (`tool-${name}`) and
// dynamic (`dynamic-tool`) shapes. Returns a wide Record so callers can
// mutate freely — the entry is the $state-proxied object from parts[]
// when the array is reactive, so writes go through the proxy.
//
// The wide return type is a deliberate concession: CourierUIMessage's
// parts union doesn't include `tool-${string}` / `dynamic-tool` variants
// (UITools defaults collapse them away in TS inference), so we trade
// narrow type access at callsites for one cast site here.
type ToolPartRef = Record<string, unknown> & {
    type: string;
    toolCallId: string;
};

function findToolPart(
    state: UIMessageReducerState,
    toolCallId: string
): ToolPartRef | undefined {
    for (const part of state.message.parts) {
        const p = part as unknown as { type?: unknown; toolCallId?: unknown };
        const t = p.type;
        if (typeof t !== 'string') continue;
        if (t !== 'dynamic-tool' && !t.startsWith('tool-')) continue;
        if (p.toolCallId !== toolCallId) continue;
        return part as unknown as ToolPartRef;
    }
    return undefined;
}

// Upsert: mutate the existing tool part in place if it exists (keeps proxy
// identity stable), or push a fresh one. Mirrors the SDK reducer's
// updateToolPart + updateDynamicToolPart paths.
function upsertToolPart(
    state: UIMessageReducerState,
    opts: ToolPartOptions
): void {
    const existing = findToolPart(state, opts.toolCallId);
    const isResultState =
        opts.state === 'output-available' || opts.state === 'output-error';

    if (existing != null) {
        const part = existing as Record<string, unknown>;
        part.state = opts.state;
        part.input = opts.input;
        part.output = opts.output;
        part.errorText = opts.errorText;
        if (opts.rawInput !== undefined) part.rawInput = opts.rawInput;
        if (opts.preliminary !== undefined) part.preliminary = opts.preliminary;
        if (opts.title !== undefined) part.title = opts.title;
        if (opts.toolMetadata !== undefined)
            part.toolMetadata = opts.toolMetadata;
        if (opts.providerExecuted !== undefined) {
            part.providerExecuted = opts.providerExecuted;
        }
        if (opts.providerMetadata != null) {
            if (isResultState) {
                part.resultProviderMetadata = opts.providerMetadata;
            } else {
                part.callProviderMetadata = opts.providerMetadata;
            }
        }
        return;
    }

    const fresh: Record<string, unknown> = opts.dynamic
        ? {
              type: 'dynamic-tool',
              toolName: opts.toolName,
              toolCallId: opts.toolCallId,
              state: opts.state,
              input: opts.input,
              output: opts.output,
              errorText: opts.errorText,
              preliminary: opts.preliminary,
              providerExecuted: opts.providerExecuted,
              title: opts.title,
          }
        : {
              type: `tool-${opts.toolName}`,
              toolCallId: opts.toolCallId,
              state: opts.state,
              title: opts.title,
              input: opts.input,
              output: opts.output,
              rawInput: opts.rawInput,
              errorText: opts.errorText,
              providerExecuted: opts.providerExecuted,
              preliminary: opts.preliminary,
          };
    if (opts.toolMetadata !== undefined) fresh.toolMetadata = opts.toolMetadata;
    if (opts.providerMetadata != null) {
        fresh[
            isResultState ? 'resultProviderMetadata' : 'callProviderMetadata'
        ] = opts.providerMetadata;
    }
    state.message.parts.push(
        fresh as unknown as CourierUIMessage['parts'][number]
    );
}

// data-* parts (we use data-attachment). Upsert by id when present;
// otherwise append. Mirrors the SDK reducer's default-case behavior minus
// the schema validation (we trust our own producer).
function handleDataChunk(
    state: UIMessageReducerState,
    chunk: { type: string; id?: string; data: unknown; transient?: boolean }
): void {
    if (chunk.transient) return;
    if (chunk.id != null) {
        for (const part of state.message.parts) {
            const p = part as { type: string; id?: string; data?: unknown };
            if (p.type === chunk.type && p.id === chunk.id) {
                p.data = chunk.data;
                return;
            }
        }
    }
    state.message.parts.push({
        type: chunk.type,
        id: chunk.id,
        data: chunk.data,
    } as unknown as CourierUIMessage['parts'][number]);
}
