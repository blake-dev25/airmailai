import type {
    ExtensionStreamEvent,
    ProviderFileRef,
    TurnRequest,
    TurnStartRequest,
} from '@airmailai/shared';
import { errorMessage, isProviderId } from '@airmailai/shared';
import { log } from '../debug';
import {
    broadcast,
    activeTurns,
    broadcastTo,
    holdExtensionUpdate,
    releaseExtensionUpdate,
} from './ports';
import { deleteProviderFiles } from './provider-file-sync';
import { TurnLifecycle, type TurnOutcome } from './turn-lifecycle';
import { captureAndPersistTurn } from './turn-persist';
import { createTurnProgress, type TurnSession } from './turn-session';
import { streamTurn } from './turn-stream';

export function handleTurnPort(port: chrome.runtime.Port): void {
    log.info('turn port connected');
    holdExtensionUpdate(port);
    const controller = new AbortController();
    const lifecycle = new TurnLifecycle();
    let acceptedRequest: TurnStartRequest | null = null;
    let portOpen = true;

    const send = (event: ExtensionStreamEvent) => {
        if (portOpen) port.postMessage(event);
    };

    const rejectStart = (message: string) => {
        send({ type: 'error', source: 'extension', message });
        if (portOpen) port.disconnect();
        releaseExtensionUpdate(port);
    };

    port.onDisconnect.addListener(() => {
        portOpen = false;
        log.info('port disconnected, phase:', lifecycle.currentPhase);
        lifecycle.disconnect();
        controller.abort();
        if (!acceptedRequest) releaseExtensionUpdate(port);
    });

    port.onMessage.addListener(async (msg: TurnRequest) => {
        if (msg.type === 'stop') {
            if (!acceptedRequest) return;
            if (!lifecycle.requestStop(msg.truncateTo)) return;
            log.info('stop received', 'truncateTo:', msg.truncateTo);
            broadcast(
                {
                    type: 'turn-truncate',
                    chatId: acceptedRequest.chatId,
                    charLen: msg.truncateTo,
                },
                acceptedRequest.sourceTabId
            );
            controller.abort();
            return;
        }

        if (!lifecycle.isPending()) return;

        if (!isProviderId(msg.provider)) {
            log.error('unknown provider, rejecting', msg.provider);
            rejectStart(`Unknown provider: ${msg.provider}`);
            return;
        }
        if (activeTurns.has(msg.chatId)) {
            log.info('lock taken, rejecting', msg.chatId);
            rejectStart('Conversation active in another tab.');
            return;
        }
        activeTurns.set(msg.chatId, msg.assistantMessageId);
        acceptedRequest = msg;
        lifecycle.start();

        broadcast(
            {
                type: 'turn-start',
                chatId: msg.chatId,
                sourceTabId: msg.sourceTabId,
                meta: msg.meta,
                assistantMessageId: msg.assistantMessageId,
                assistantCreatedAt: msg.assistantCreatedAt,
            },
            msg.sourceTabId
        );

        const session: TurnSession = {
            request: msg,
            lifecycle,
            signal: controller.signal,
            send,
        };
        const progress = createTurnProgress(msg);

        let orphanedReplicas: ProviderFileRef[] = [];
        try {
            await streamTurn(session, progress);
            orphanedReplicas = await captureAndPersistTurn(session, progress);
        } catch (error) {
            log.error('turn failed unexpectedly', error);
            lifecycle.finalizeFailed(
                `Couldn't finish the response: ${errorMessage(error)}`
            );
        }

        if (progress.outputWarnings.length) {
            broadcastTo(
                {
                    type: 'turn-warning',
                    chatId: msg.chatId,
                    message: progress.outputWarnings.join('\n'),
                },
                msg.sourceTabId
            );
        }
        const outcome = lifecycle.finish();

        if (activeTurns.get(msg.chatId) === msg.assistantMessageId) {
            activeTurns.delete(msg.chatId);
        }
        try {
            reportOutcome(outcome, msg, progress.chatRevision, send);
            if (portOpen) port.disconnect();
            await cleanupProviderFiles(msg, orphanedReplicas);
        } finally {
            releaseExtensionUpdate(port);
        }
    });
}

function reportOutcome(
    outcome: TurnOutcome,
    request: TurnStartRequest,
    chatRevision: number | null,
    send: (event: ExtensionStreamEvent) => void
): void {
    if (outcome.kind === 'errored') {
        send({
            type: 'error',
            source: outcome.source,
            message: outcome.message,
            ...(chatRevision !== null ? { revision: chatRevision } : {}),
        });
        broadcast(
            {
                type: 'turn-error',
                chatId: request.chatId,
                message: outcome.message,
                source: outcome.source,
            },
            request.sourceTabId
        );
        return;
    }
    if (outcome.kind === 'aborted') {
        broadcast(
            { type: 'turn-aborted', chatId: request.chatId },
            request.sourceTabId
        );
        return;
    }
    if (chatRevision !== null) {
        send({ type: 'done', revision: chatRevision });
    }
    broadcast(
        { type: 'turn-done', chatId: request.chatId },
        request.sourceTabId
    );
}

async function cleanupProviderFiles(
    request: TurnStartRequest,
    orphaned: ProviderFileRef[]
): Promise<void> {
    const warnings = await deleteProviderFiles(orphaned);
    if (!warnings.length) return;
    broadcastTo(
        {
            type: 'turn-warning',
            chatId: request.chatId,
            message: warnings.join('\n'),
        },
        request.sourceTabId
    );
}
