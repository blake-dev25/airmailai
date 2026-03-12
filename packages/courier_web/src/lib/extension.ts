import type {
	ExtensionRequest,
	ExtensionResponse,
	StorageRequest,
	StorageResponse,
} from '@courier/shared';

let extensionId: string | null = null;

// Listen for content script to broadcast the extension ID
window.addEventListener('message', (e: MessageEvent) => {
	if (e.data?.type === 'COURIER_EXT_READY' && typeof e.data.id === 'string') {
		extensionId = e.data.id;
	}
});

// Ping in case this module loads after the content script already fired
window.postMessage({ type: 'COURIER_EXT_PING' }, '*');

export function isExtensionReady(): boolean {
	return extensionId !== null;
}

async function sendStorageMessage(
	request: StorageRequest
): Promise<StorageResponse> {
	if (!extensionId)
		return { type: 'error', message: 'Extension not detected.' };
	return new Promise((resolve) => {
		chrome.runtime.sendMessage(
			extensionId as string,
			request,
			(response: StorageResponse) => {
				resolve(
					response ?? { type: 'error', message: 'No response from extension.' }
				);
			}
		);
	});
}

export async function saveApiKey(
	provider: string,
	apiKey: string
): Promise<boolean> {
	const response = await sendStorageMessage({
		type: 'save_key',
		provider,
		apiKey,
	});
	return response.type === 'saved';
}

export async function checkApiKeys(
	providers: string[]
): Promise<Record<string, boolean>> {
	const response = await sendStorageMessage({ type: 'has_keys', providers });
	if (response.type === 'has_keys') return response.saved;
	return Object.fromEntries(providers.map((p) => [p, false]));
}

export function sendToExtension(
	request: ExtensionRequest,
	onChunk: (text: string) => void,
	onDone: () => void,
	onError: (message: string) => void
): void {
	if (!extensionId) {
		onError(
			'CourierAI extension not detected. Install it and refresh to start chatting.'
		);
		return;
	}

	let done = false;
	const port = chrome.runtime.connect(extensionId);

	port.onMessage.addListener((response: ExtensionResponse) => {
		switch (response.type) {
			case 'chunk':
				onChunk(response.content);
				break;
			case 'done':
				done = true;
				onDone();
				port.disconnect();
				break;
			case 'error':
				done = true;
				onError(response.message);
				port.disconnect();
				break;
		}
	});

	port.onDisconnect.addListener(() => {
		if (!done)
			onError(
				chrome.runtime.lastError?.message ??
					'Extension disconnected unexpectedly.'
			);
	});

	port.postMessage(request);
}
