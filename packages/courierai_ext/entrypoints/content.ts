// Broadcasts the extension ID to the host page so it can initiate port connections.
// Two channels:
//  1. Synchronous DOM marker at document_start — page JS can read it without
//     waiting (immune to CPU throttling that delays message round-trips).
//  2. window.postMessage — kept as a fallback / re-announce path.
const LOG = '[courier:ext]';

export default defineContentScript({
    matches: ['http://localhost:*/*', 'https://*.courierai.net/*'],
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
