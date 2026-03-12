import type {
	ExtensionRequest,
	ExtensionResponse,
	StorageRequest,
	StorageResponse,
} from '@courier/shared';
import { streamAnthropic } from '../providers/anthropic';

async function handleStorage(
	message: StorageRequest
): Promise<StorageResponse> {
	switch (message.type) {
		case 'save_key': {
			await chrome.storage.sync.set({
				[`apiKey_${message.provider}`]: message.apiKey,
			});
			return { type: 'saved' };
		}
		case 'has_keys': {
			const storageKeys = message.providers.map((p) => `apiKey_${p}`);
			const result = await chrome.storage.sync.get(storageKeys);
			const saved: Record<string, boolean> = {};
			for (const p of message.providers) {
				const val = result[`apiKey_${p}`];
				saved[p] = typeof val === 'string' && val.length > 0;
			}
			return { type: 'has_keys', saved };
		}
	}
}

export default defineBackground(() => {
	// One-off storage operations (save/check API keys)
	chrome.runtime.onMessageExternal.addListener(
		(message: StorageRequest, _sender, sendResponse) => {
			handleStorage(message).then(sendResponse);
			return true; // keep channel open for async response
		}
	);

	// Streaming chat over a port
	chrome.runtime.onConnectExternal.addListener((port) => {
		port.onMessage.addListener(async (request: ExtensionRequest) => {
			const send = (response: ExtensionResponse) => port.postMessage(response);

			const keyResult = await chrome.storage.sync.get(
				`apiKey_${request.provider}`
			);
			const apiKey = keyResult[`apiKey_${request.provider}`] as
				| string
				| undefined;

			if (!apiKey) {
				send({
					type: 'error',
					message: `No API key saved for ${request.provider}. Add one in Settings.`,
				});
				return;
			}

			switch (request.provider) {
				case 'anthropic':
					await streamAnthropic(
						apiKey,
						request.model,
						request.messages,
						request.params ?? {},
						(text) => send({ type: 'chunk', content: text }),
						() => send({ type: 'done' }),
						(msg) => send({ type: 'error', message: msg })
					);
					break;
				default:
					send({
						type: 'error',
						message: `Unsupported provider: ${request.provider}`,
					});
			}
		});
	});
});
