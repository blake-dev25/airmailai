import type { AirmailAIChunk, ProviderStreamArgs } from '@airmailai/shared';
import { streamAnthropic } from './anthropic';
import { streamGoogle } from './google';
import { streamOpenAI } from './openai';
import { streamOpenRouter } from './openrouter';

export function streamProvider(
    provider: string,
    args: ProviderStreamArgs
): AsyncIterable<AirmailAIChunk> {
    switch (provider) {
        case 'anthropic':
            return streamAnthropic(args);
        case 'openai':
            return streamOpenAI(args);
        case 'google':
            return streamGoogle(args);
        case 'openrouter':
            return streamOpenRouter(args);
        default:
            throw new Error(`Unsupported provider: ${provider}`);
    }
}
