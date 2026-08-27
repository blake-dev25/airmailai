import type { StorageRequest } from '@airmailai/shared';
import { handleFileTransferPort } from '../background/file-transfer';
import { handleBroadcastPort, queuePendingUpdate } from '../background/ports';
import { dispatchStorage } from '../background/storage-handler';
import { handleTurnPort } from '../background/turn';
import { log } from '../debug';

export default defineBackground(() => {
    log.info('background ready');

    chrome.runtime.onUpdateAvailable.addListener((details) => {
        log.info('extension update available', details.version);
        queuePendingUpdate(details.version);
    });

    chrome.runtime.onMessage.addListener(
        (message: StorageRequest, _sender, sendResponse) => {
            if (message.type !== 'clear_chats' && message.type !== 'clear_all')
                return;
            return dispatchStorage(message, sendResponse);
        }
    );

    chrome.runtime.onMessageExternal.addListener(
        (message: StorageRequest, _sender, sendResponse) =>
            dispatchStorage(message, sendResponse)
    );

    chrome.runtime.onConnectExternal.addListener((port) => {
        if (port.name === 'file-transfer') {
            handleFileTransferPort(port);
            return;
        }
        if (port.name === 'broadcast') {
            handleBroadcastPort(port);
            return;
        }
        handleTurnPort(port);
    });
});
