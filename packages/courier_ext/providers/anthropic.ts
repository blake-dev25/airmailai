import Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage } from '@courier/shared';
import { DEBUG_API_LOGGING } from '../debug';

const LOG = '[courier:ext]';

export async function streamAnthropic(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  params: Record<string, unknown>,
  onChunk: (text: string) => void,
  onDone: (usage: { inputTokens: number; outputTokens: number } | null) => void,
  onError: (message: string) => void,
  onThinkingChunk?: (text: string) => void
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

  const thinkingLevel = params.thinkingLevel as string | undefined;
  const thinkingEnabled = thinkingLevel && thinkingLevel !== 'none';

  try {
    const stream = client.messages.stream({
      model,
      max_tokens: (params.maxTokens as number) ?? 8192,
      temperature: (params.temperature as number) ?? 1,
      ...(thinkingEnabled
        ? {
            thinking: { type: 'adaptive' } as never,
            output_config: { effort: thinkingLevel } as never,
          }
        : {}),
      ...(systemMsg ? { system: systemMsg.content } : {}),
      messages: chatMessages,
    });

    let firstChunk = true;
    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        const delta = event.delta as {
          type: string;
          text?: string;
          thinking?: string;
        };
        if (delta.type === 'text_delta' && delta.text) {
          if (firstChunk) {
            console.log(LOG, 'anthropic: first chunk received');
            firstChunk = false;
          }
          onChunk(delta.text);
        } else if (
          delta.type === 'thinking_delta' &&
          delta.thinking &&
          onThinkingChunk
        ) {
          onThinkingChunk(delta.thinking);
        }
      }
    }

    console.log(LOG, 'anthropic: stream done');
    const finalMsg = await stream.finalMessage();
    if (DEBUG_API_LOGGING) {
      console.log(LOG, '[debug] full response', finalMsg);
    }
    const usage = finalMsg.usage
      ? {
          inputTokens: finalMsg.usage.input_tokens,
          outputTokens: finalMsg.usage.output_tokens,
        }
      : null;
    onDone(usage);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(LOG, 'anthropic: error', msg);
    onError(msg);
  }
}
