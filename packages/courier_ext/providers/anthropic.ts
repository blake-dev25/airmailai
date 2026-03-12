import Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage } from '@courier/shared';

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

	try {
		const stream = client.messages.stream({
			model,
			max_tokens: (params.maxTokens as number) ?? 8192,
			temperature: (params.temperature as number) ?? 1,
			...(systemMsg ? { system: systemMsg.content } : {}),
			messages: chatMessages,
		});

		for await (const event of stream) {
			if (
				event.type === 'content_block_delta' &&
				event.delta.type === 'text_delta'
			) {
				onChunk(event.delta.text);
			}
		}

		onDone();
	} catch (e) {
		onError(e instanceof Error ? e.message : String(e));
	}
}
