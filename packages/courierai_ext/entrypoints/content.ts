const LOG = '[courierai:ext]';

// *** TODO(static-id): once the extension is published to the Chrome Web Store its
// ID is static. The website will then probe the hardcoded ID directly via
// chrome.runtime.sendMessage; delete this content script and the READY/PING
// handshake in courierai_web's extension.ts.
export default defineContentScript({
    matches: __ALLOW_LOCALHOST__
        ? ['http://localhost:*/*', 'https://*.courierai.net/*']
        : ['https://*.courierai.net/*'],
    runAt: 'document_start',
    main() {
        document.documentElement.dataset.courieraiExtId = chrome.runtime.id;

        const announce = () => {
            console.log(
                LOG,
                'content: announcing extension ID',
                chrome.runtime.id
            );
            window.postMessage(
                { type: 'COURIERAI_EXT_READY', id: chrome.runtime.id },
                '*'
            );
        };

        announce();

        window.addEventListener('message', (e) => {
            if (e.data?.type === 'COURIERAI_EXT_PING') {
                console.log(LOG, 'content: ping received, re-announcing');
                announce();
            }
        });
    },
});
