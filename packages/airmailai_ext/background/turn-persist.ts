import type {
    AirmailAIMessage,
    ProviderFileRef,
    StoredMessage,
} from '@airmailai/shared';
import { errorMessage, truncateMessageTextParts } from '@airmailai/shared';
import { log } from '../debug';
import { dbPutMessage, dbSetContainer } from '../storage/db';
import { broadcastTo } from './ports';
import { captureOpenAIOutputs } from './turn-files';
import type { TurnProgress, TurnSession } from './turn-session';

export async function captureAndPersistTurn(
    session: TurnSession,
    progress: TurnProgress
): Promise<ProviderFileRef[]> {
    const { request, lifecycle, signal } = session;
    lifecycle.beginCapturing();
    const assembled = progress.assembler.message;
    const truncateBeforeCapture = lifecycle.truncateTo();
    if (truncateBeforeCapture !== null) {
        truncateMessageTextParts(assembled, truncateBeforeCapture);
    }
    if (!lifecycle.persistsMessage() || assembled.parts.length === 0) {
        return [];
    }

    const finalMessage: AirmailAIMessage = {
        ...assembled,
        id: request.assistantMessageId,
        role: 'assistant',
        metadata: {
            createdAt: request.assistantCreatedAt,
            model: `${request.provider}/${request.model}`,
            ...(assembled.metadata.tokens
                ? { tokens: assembled.metadata.tokens }
                : {}),
            ...(assembled.metadata.stopReason
                ? { stopReason: assembled.metadata.stopReason }
                : {}),
            ...(assembled.metadata.refusalExplanation
                ? {
                      refusalExplanation: assembled.metadata.refusalExplanation,
                  }
                : {}),
        },
    };
    const freshBlobs = new Map(progress.outputBlobs);
    const capturedParts: AirmailAIMessage['parts'] = [];
    let containerFileIds: string[] | undefined;
    if (
        progress.apiKey &&
        request.provider === 'openai' &&
        progress.container
    ) {
        try {
            const captured = await captureOpenAIOutputs(
                request.chatId,
                progress.apiKey,
                progress.container.id,
                progress.storageOn,
                signal
            );
            for (const [hash, blob] of captured.freshBlobs) {
                freshBlobs.set(hash, blob);
            }
            capturedParts.push(...captured.parts);
            containerFileIds = captured.containerFileIds;
            if (captured.warning) {
                progress.outputWarnings.push(
                    `Saved generated file(s) on this device, but couldn't copy to OpenAI storage (will retry on your next message): ${captured.warning}`
                );
            }
        } catch (err) {
            if (signal.aborted) {
                log.info('output capture aborted by stop');
            } else {
                log.error('output capture failed', err);
                lifecycle.finalizeFailed(
                    `Couldn't download generated file(s): ${errorMessage(err)}`
                );
            }
        }
    }

    lifecycle.beginPersisting();
    const truncateAfterCapture = lifecycle.truncateTo();
    if (truncateAfterCapture !== null) {
        truncateMessageTextParts(finalMessage, truncateAfterCapture);
    }
    finalMessage.parts.push(...capturedParts);
    const stored: StoredMessage = {
        chatId: request.chatId,
        message: finalMessage,
    };
    let orphanedReplicas: ProviderFileRef[] = [];
    try {
        const saved = await dbPutMessage(stored, freshBlobs);
        orphanedReplicas = saved.refs;
        progress.chatRevision = saved.revision;
    } catch (err) {
        log.error('save failed', err);
        lifecycle.finalizeFailed(
            `Couldn't save assistant message: ${errorMessage(err)}`
        );
    }
    if (progress.container) {
        try {
            await dbSetContainer(
                request.chatId,
                request.provider,
                progress.container.id,
                progress.container.expiresAt,
                containerFileIds
            );
        } catch (err) {
            log.error('container persist failed', err);
            broadcastTo(
                {
                    type: 'turn-warning',
                    chatId: request.chatId,
                    message: `Couldn't save the code execution session for this chat, so the next message may start a new one: ${errorMessage(err)}`,
                },
                request.sourceTabId
            );
        }
    }
    return orphanedReplicas;
}
