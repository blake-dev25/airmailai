import type { CourierAIChunk, ProviderStreamArgs } from '@courierai/shared';
import { streamAnthropic } from './anthropic';
import { streamGoogle } from './google';
import { streamOpenAI } from './openai';
import { streamOpenRouter } from './openrouter';

export type ProviderId = 'anthropic' | 'openai' | 'google' | 'openrouter';

// The switch is the security boundary that decides which provider SDK (and
// therefore which URL) a turn request can reach. The website is untrusted - we
// never dispatch on an arbitrary provider string it sent us. Throw on unknowns
// rather than falling through.
export function streamProvider(
    provider: string,
    args: ProviderStreamArgs
): AsyncIterable<CourierAIChunk> {
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
