import type { BroadcastEvent, BroadcastRequest } from '@airmailai/shared';
import { log } from '../debug';

const broadcastPorts = new Map<chrome.runtime.Port, string | undefined>();

const streamPorts = new Set<chrome.runtime.Port>();
let pendingUpdateVersion: string | null = null;

export function trackStreamPort(port: chrome.runtime.Port): void {
    streamPorts.add(port);
}

export function releaseStreamPort(port: chrome.runtime.Port): void {
    streamPorts.delete(port);
    maybeApplyPendingUpdate();
}

export function queuePendingUpdate(version: string): void {
    pendingUpdateVersion = version;
    maybeApplyPendingUpdate();
}

function maybeApplyPendingUpdate(): void {
    if (pendingUpdateVersion === null) return;
    if (streamPorts.size > 0) return;
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
            };
            try {
                port.postMessage(hello);
            } catch {
                broadcastPorts.delete(port);
            }
            return;
        }
        if (msg.type === 'keepalive') return;
    });
    port.onDisconnect.addListener(() => {
        const reason = chrome.runtime.lastError?.message;
        log.info('broadcast port disconnected', reason ? `(${reason})` : '');
        broadcastPorts.delete(port);
    });
}
