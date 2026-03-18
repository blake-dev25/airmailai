import type {
	ExtensionRequest,
	ExtensionResponse,
	StorageRequest,
	StorageResponse,
	StoredChat,
	UserSettings,
} from '@courier/shared';

const LOG = '[courier:web]';

let extensionId: string | null = null;

// Listen for content script to broadcast the extension ID
window.addEventListener('message', (e: MessageEvent) => {
	if (e.data?.type === 'COURIER_EXT_READY' && typeof e.data.id === 'string') {
		extensionId = e.data.id;
		console.log(LOG, 'extension ID received', extensionId);
	}
});

// Ping in case this module loads after the content script already fired
window.postMessage({ type: 'COURIER_EXT_PING' }, '*');

export function isExtensionReady(): boolean {
	return extensionId !== null;
}

// Resolves true when the extension is detected, false on timeout
export function waitForExtension(timeoutMs = 2000): Promise<boolean> {
	if (extensionId) return Promise.resolve(true);
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			window.removeEventListener('message', handler);
			resolve(false);
		}, timeoutMs);
		function handler(e: MessageEvent) {
			if (
				e.data?.type === 'COURIER_EXT_READY' &&
				typeof e.data.id === 'string'
			) {
				clearTimeout(timer);
				window.removeEventListener('message', handler);
				resolve(true);
			}
		}
		window.addEventListener('message', handler);
	});
}

async function sendStorageMessage(
	request: StorageRequest
): Promise<StorageResponse> {
	if (!extensionId) {
		console.error(
			LOG,
			'storage: extension not detected, cannot send',
			request.type
		);
		return { type: 'error', message: 'Extension not detected.' };
	}
	console.log(LOG, '→ storage', request.type);
	return new Promise((resolve) => {
		chrome.runtime.sendMessage(
			extensionId as string,
			request,
			(response: StorageResponse) => {
				const result = response ?? {
					type: 'error',
					message: 'No response from extension.',
				};
				if (result.type === 'error') {
					console.error(LOG, '← storage error', result.message);
				} else {
					console.log(LOG, '← storage', result.type);
				}
				resolve(result);
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

export async function saveSettings(
	settings: Partial<UserSettings>
): Promise<void> {
	await sendStorageMessage({ type: 'save_settings', settings });
}

export async function loadSettings(): Promise<Partial<UserSettings>> {
	const response = await sendStorageMessage({ type: 'load_settings' });
	if (response.type === 'settings') return response.settings;
	return {};
}

export async function saveChat(chat: StoredChat): Promise<void> {
	await sendStorageMessage({ type: 'save_chat', chat });
}

export async function deleteChat(chatId: string): Promise<void> {
	await sendStorageMessage({ type: 'delete_chat', chatId });
}

export async function loadChats(): Promise<StoredChat[]> {
	const response = await sendStorageMessage({ type: 'load_chats' });
	if (response.type === 'chats') return response.chats;
	return [];
}

export function sendToExtension(
	request: ExtensionRequest,
	onChunk: (text: string) => void,
	onDone: () => void,
	onError: (message: string) => void
): void {
	if (!extensionId) {
		console.error(LOG, 'chat: extension not detected');
		onError(
			'CourierAI extension not detected. Install it and refresh to start chatting.'
		);
		return;
	}

	console.log(LOG, '→ chat request', {
		provider: request.provider,
		model: request.model,
		messages: request.messages.length,
		params: request.params,
	});

	let done = false;
	let firstChunk = true;
	const port = chrome.runtime.connect(extensionId);

	port.onMessage.addListener((response: ExtensionResponse) => {
		switch (response.type) {
			case 'chunk':
				if (firstChunk) {
					console.log(LOG, '← first chunk received');
					firstChunk = false;
				}
				onChunk(response.content);
				break;
			case 'done':
				done = true;
				console.log(LOG, '← stream done');
				onDone();
				port.disconnect();
				break;
			case 'error':
				done = true;
				console.error(LOG, '← stream error', response.message);
				onError(response.message);
				port.disconnect();
				break;
		}
	});

	port.onDisconnect.addListener(() => {
		if (!done) {
			const msg =
				chrome.runtime.lastError?.message ??
				'Extension disconnected unexpectedly.';
			console.error(LOG, '✗ unexpected port disconnect', msg);
			onError(msg);
		}
	});

	port.postMessage(request);
}
