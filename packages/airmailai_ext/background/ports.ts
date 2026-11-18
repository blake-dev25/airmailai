import type { BroadcastEvent, BroadcastRequest } from '@airmailai/shared';
import { log } from '../debug';

const broadcastPorts = new Map<chrome.runtime.Port, string | undefined>();

const extensionUpdateHolds = new Set<object>();
export const activeTurns = new Map<string, string>();
let pendingUpdateVersion: string | null = null;

export function holdExtensionUpdate(holder: object): void {
    extensionUpdateHolds.add(holder);
}

export function releaseExtensionUpdate(holder: object): void {
    extensionUpdateHolds.delete(holder);
    maybeApplyPendingUpdate();
}

export function queuePendingUpdate(version: string): void {
    pendingUpdateVersion = version;
    maybeApplyPendingUpdate();
}

function maybeApplyPendingUpdate(): void {
    if (pendingUpdateVersion === null) return;
    if (extensionUpdateHolds.size > 0) return;
    log.info('applying pending extension update', pendingUpdateVersion);
    chrome.runtime.reload();
}

export function broadcast(event: BroadcastEvent, skipTabId?: string) {
    for (const [port, tabId] of broadcastPorts) {
        if (skipTabId && tabId === skipTabId) continue;
        try {
            port.postMessage(event);
        } catch {
            broadcastPorts.delete(port);
        }
    }
}

export function broadcastTo(
    event: BroadcastEvent,
    targetTabId: string | undefined
) {
    if (targetTabId) {
        for (const [port, tabId] of broadcastPorts) {
            if (tabId !== targetTabId) continue;
            try {
                port.postMessage(event);
                return;
            } catch {
                broadcastPorts.delete(port);
            }
        }
    }
    broadcast(event);
}

export function handleBroadcastPort(port: chrome.runtime.Port): void {
    log.info('broadcast port connected');
    broadcastPorts.set(port, undefined);
    port.onMessage.addListener((msg: BroadcastRequest) => {
        if (msg.type === 'register') {
            broadcastPorts.set(port, msg.sourceTabId);
            const hello: BroadcastEvent = {
                type: 'ext-hello',
                version: chrome.runtime.getManifest().version,
                activeChatIds: [...activeTurns.keys()],
            };
            try {
                port.postMessage(hello);
            } catch {
                broadcastPorts.delete(port);
            }
        }
    });
    port.onDisconnect.addListener(() => {
        const reason = chrome.runtime.lastError?.message;
        log.info('broadcast port disconnected', reason ? `(${reason})` : '');
        broadcastPorts.delete(port);
    });
}
