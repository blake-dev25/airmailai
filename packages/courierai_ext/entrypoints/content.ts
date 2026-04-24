// Broadcasts the extension ID to the host page so it can initiate port connections.
// Uses a ping/pong in case the page listener isn't ready when this fires.
const LOG = '[courier:ext]';

export default defineContentScript({
    matches: ['http://localhost:*/*', 'https://*.courierai.net/*'],
    runAt: 'document_idle',
    main() {
        const announce = () => {
            console.log(
                LOG,
                'content: announcing extension ID',
                chrome.runtime.id
            );
            window.postMessage(
                { type: 'COURIER_EXT_READY', id: chrome.runtime.id },
                '*'
            );
        };

        announce();

        window.addEventListener('message', (e) => {
            if (e.data?.type === 'COURIER_EXT_PING') {
                console.log(LOG, 'content: ping received, re-announcing');
                announce();
            }
        });
    },
});
