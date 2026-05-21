import type { BroadcastEvent } from '@courier/shared';
import { chatStore } from './chatStore.svelte';
import { subscribeToBroadcast, tabId } from './extension';

function handleBroadcastEvent(event: BroadcastEvent): void {
    switch (event.type) {
        case 'turn-start':
            // The source tab's local streamingChatIds already contains chatId
            // by the time turn-start arrives. Filter on sourceTabId so the
            // originating tab ignores its own echo.
            if (event.sourceTabId === tabId) return;
            chatStore.applyRemoteTurnStart(
                event.chatId,
                event.meta,
                event.history,
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
    }
}

async function handleBroadcastReconnect(): Promise<void> {
    // Broadcast port reconnected (e.g. service worker came back from
    // eviction). We may have missed events — at minimum, refresh the active
    // chat from IDB so the user sees canonical state.
    await chatStore.refreshActiveFromIDB();
}

export function startBroadcastBridge(): () => void {
    const sub = subscribeToBroadcast({
        onEvent: handleBroadcastEvent,
        onReconnect: handleBroadcastReconnect,
    });
    return () => sub.unsubscribe();
}
