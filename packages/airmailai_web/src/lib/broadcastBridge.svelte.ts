import type { BroadcastEvent } from '@airmailai/shared';
import { chatStore } from './chatStore.svelte';
import { reportAppError } from './errorStore.svelte';
import { clearFileBlobCache, subscribeToBroadcast, tabId } from './extension';
import { versionCheck } from './versionCheck.svelte';

const messageUpdates = new Map<string, Promise<void>>();
let helloReceived = false;

function handleBroadcastEvent(event: BroadcastEvent): void {
    switch (event.type) {
        case 'ext-hello':
            versionCheck.reportExtVersion(event.version);
            if (helloReceived) {
                void chatStore.reconcileFromIDB(event.activeChatIds);
            } else {
                helloReceived = true;
                chatStore.syncActiveTurns(event.activeChatIds);
            }
            return;
        case 'message-changed': {
            const previous =
                messageUpdates.get(event.chatId) ?? Promise.resolve();
            const update = previous
                .then(() =>
                    chatStore.applyMessageChanged(
                        event.chatId,
                        event.messageId,
                        event.revision
                    )
                )
                .catch((error) =>
                    reportAppError(
                        'message synchronization failed',
                        "Couldn't synchronize the conversation",
                        error
                    )
                );
            messageUpdates.set(event.chatId, update);
            void update.finally(() => {
                if (messageUpdates.get(event.chatId) === update)
                    messageUpdates.delete(event.chatId);
            });
            return;
        }
        case 'turn-start':
            if (event.sourceTabId === tabId) return;
            chatStore.applyRemoteTurnStart(
                event.chatId,
                event.meta,
                event.assistantMessageId,
                event.assistantCreatedAt
            );
            return;
        case 'turn-chunk':
            chatStore.applyRemoteTurnChunk(event.chatId, event.chunk);
            return;
        case 'turn-done':
            chatStore.applyRemoteTurnDone(event.chatId);
            return;
        case 'turn-error':
            chatStore.applyRemoteTurnError(
                event.chatId,
                event.message,
                event.source
            );
            return;
        case 'turn-aborted':
            chatStore.applyRemoteTurnAborted(event.chatId);
            return;
        case 'turn-truncate':
            chatStore.applyRemoteTurnTruncate(event.chatId, event.charLen);
            return;
        case 'turn-warning':
            reportAppError(
                `turn cleanup warning (chatId=${event.chatId})`,
                event.message,
                new Error(event.message)
            );
            return;
        case 'files-changed':
            clearFileBlobCache();
            void chatStore.refreshLoadedChats(event.chatIds);
            return;
        case 'replica-warning':
            reportAppError(
                `draft replica upload failed (chatId=${event.chatId})`,
                `Saved ${event.filename} on this device, but couldn't copy it to ${event.provider} storage (will retry when you send)`,
                new Error(event.message)
            );
            return;
        case 'meta-changed':
            chatStore.applyRemoteMetaChanged(event.meta);
            return;
        case 'chat-deleted':
            chatStore.applyRemoteChatDeleted(event.chatId);
            return;
        case 'chats-cleared':
            chatStore.resetLocal();
            return;
    }
}

export function startBroadcastBridge(): () => void {
    const sub = subscribeToBroadcast({
        onEvent: handleBroadcastEvent,
    });
    return () => sub.unsubscribe();
}
