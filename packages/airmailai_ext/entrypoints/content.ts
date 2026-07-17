import { log } from '../debug';

// *** TODO(static-id): once the extension is published to the Chrome Web Store its
// ID is static. The website will then probe the hardcoded ID directly via
// chrome.runtime.sendMessage; delete this content script and the READY/PING
// handshake in airmailai_web's extension.ts. The probe response must keep
// reporting the extension version and versionName.
export default defineContentScript({
    matches: __ALLOW_LOCALHOST__
        ? ['http://localhost:*/*', 'https://airmailai.net/*']
        : ['https://airmailai.net/*'],
    runAt: 'document_start',
    main() {
        const manifest = chrome.runtime.getManifest();
        const dataset = document.documentElement.dataset;
        dataset.airmailaiExtId = chrome.runtime.id;
        dataset.airmailaiExtVersion = manifest.version;
        if (manifest.version_name)
            dataset.airmailaiExtVersionName = manifest.version_name;

        const announce = () => {
            log.info('content: announcing extension ID', chrome.runtime.id);
            window.postMessage(
                {
                    type: 'AIRMAILAI_EXT_READY',
                    id: chrome.runtime.id,
                    version: manifest.version,
                    ...(manifest.version_name
                        ? { versionName: manifest.version_name }
                        : {}),
                },
                '*'
            );
        };

        announce();

        window.addEventListener('message', (e) => {
            if (e.data?.type === 'AIRMAILAI_EXT_PING') {
                log.info('content: ping received, re-announcing');
                announce();
            }
        });
    },
});
