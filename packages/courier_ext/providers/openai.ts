import type { ChatMessage } from '@courier/shared';
import OpenAI from 'openai';
import { DEBUG_API_LOGGING } from '../debug';

const LOG = '[courier:ext]';

export async function streamOpenAI(
	apiKey: string,
	model: string,
	messages: ChatMessage[],
	params: Record<string, unknown>,
	onChunk: (text: string) => void,
	onDone: (usage: { inputTokens: number; outputTokens: number } | null) => void,
	onError: (message: string) => void
): Promise<void> {
	const client = new OpenAI({ apiKey, dangerouslyAllowBrowser: true });

	const systemMsg = messages.find((m) => m.role === 'system');
	const inputMessages = messages
		.filter((m) => m.role !== 'system')
		.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

	console.log(LOG, 'openai: stream start', {
		model,
		inputMessages: inputMessages.length,
		hasSystem: !!systemMsg,
		params,
	});

	try {
		const stream = await client.responses.create({
			model,
			input: inputMessages,
			...(systemMsg ? { instructions: systemMsg.content } : {}),
			max_output_tokens: (params.maxTokens as number) ?? 8192,
			temperature: (params.temperature as number) ?? 1,
			stream: true,
		});

		let firstChunk = true;
		let usage: { inputTokens: number; outputTokens: number } | null = null;

		for await (const event of stream) {
			if (event.type === 'response.output_text.delta') {
				if (firstChunk) {
					console.log(LOG, 'openai: first chunk received');
					firstChunk = false;
				}
				onChunk(event.delta);
			} else if (event.type === 'response.completed') {
				if (DEBUG_API_LOGGING) {
					console.log(LOG, '[debug] full response', event.response);
				}
				const u = event.response.usage;
				if (u) {
					usage = {
						inputTokens: u.input_tokens,
						outputTokens: u.output_tokens,
					};
				}
			}
		}

		console.log(LOG, 'openai: stream done');
		onDone(usage);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.error(LOG, 'openai: error', msg);
		onError(msg);
	}
}
