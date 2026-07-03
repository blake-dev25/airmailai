import type { BroadcastEvent } from '@courierai/shared';
import { chatStore } from './chatStore.svelte';
import { subscribeToBroadcast, tabId } from './extension';

function handleBroadcastEvent(event: BroadcastEvent): void {
    switch (event.type) {
        case 'turn-start':
            if (event.sourceTabId === tabId) return;
            chatStore.applyRemoteTurnStart(
                event.chatId,
                event.meta,
                event.assistantMessageId
            );
            return;
        case 'turn-chunk':
            chatStore.applyRemoteTurnChunk(event.chatId, event.chunk);
            return;
        case 'turn-done':
            chatStore.applyRemoteTurnDone(event.chatId);
            return;
        case 'turn-error':
            chatStore.applyRemoteTurnError(event.chatId, event.message);
            return;
        case 'turn-aborted':
            chatStore.applyRemoteTurnAborted(event.chatId);
            return;
        case 'turn-truncate':
            chatStore.applyRemoteTurnTruncate(event.chatId, event.charLen);
            return;
        case 'files-changed':
            void chatStore.refreshLoadedChats(event.chatIds);
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

async function handleBroadcastReconnect(): Promise<void> {
    await chatStore.refreshActiveFromIDB();
}

export function startBroadcastBridge(): () => void {
    const sub = subscribeToBroadcast({
        onEvent: handleBroadcastEvent,
        onReconnect: handleBroadcastReconnect,
    });
    return () => sub.unsubscribe();
}
