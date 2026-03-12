// Broadcasts the extension ID to the host page so it can initiate port connections.
// Uses a ping/pong in case the page listener isn't ready when this fires.
export default defineContentScript({
	matches: ['https://courier-ai.com/*', 'http://localhost:*/*'],
	runAt: 'document_idle',
	main() {
		const announce = () =>
			window.postMessage(
				{ type: 'COURIER_EXT_READY', id: chrome.runtime.id },
				'*'
			);

		announce();

		window.addEventListener('message', (e) => {
			if (e.data?.type === 'COURIER_EXT_PING') announce();
		});
	},
});
