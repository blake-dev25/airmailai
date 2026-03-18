import Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage } from '@courier/shared';

const LOG = '[courier:ext]';

export async function streamAnthropic(
	apiKey: string,
	model: string,
	messages: ChatMessage[],
	params: Record<string, unknown>,
	onChunk: (text: string) => void,
	onDone: () => void,
	onError: (message: string) => void
): Promise<void> {
	const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

	const systemMsg = messages.find((m) => m.role === 'system');
	const chatMessages = messages.filter(
		(m) => m.role !== 'system'
	) as Anthropic.MessageParam[];

	console.log(LOG, 'anthropic: stream start', {
		model,
		chatMessages: chatMessages.length,
		hasSystem: !!systemMsg,
		params,
	});

	try {
		const stream = client.messages.stream({
			model,
			max_tokens: (params.maxTokens as number) ?? 8192,
			temperature: (params.temperature as number) ?? 1,
			...(systemMsg ? { system: systemMsg.content } : {}),
			messages: chatMessages,
		});

		let firstChunk = true;
		for await (const event of stream) {
			if (
				event.type === 'content_block_delta' &&
				event.delta.type === 'text_delta'
			) {
				if (firstChunk) {
					console.log(LOG, 'anthropic: first chunk received');
					firstChunk = false;
				}
				onChunk(event.delta.text);
			}
		}

		console.log(LOG, 'anthropic: stream done');
		onDone();
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.error(LOG, 'anthropic: error', msg);
		onError(msg);
	}
}
