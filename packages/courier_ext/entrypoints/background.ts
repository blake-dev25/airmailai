export default defineBackground(() => {
	// Handle port connections from the Courier website
	chrome.runtime.onConnectExternal.addListener((port) => {
		port.onMessage.addListener((_request) => {
			// TODO: route to provider adapter and stream response back
		});
	});
});
