import type { ModelMessage, StreamTextResult, ToolSet } from 'ai';
import { streamAnthropic } from './anthropic';
import { streamGoogle } from './google';
import { streamOpenAI } from './openai';
import { streamOpenRouter } from './openrouter';

export type ProviderId = 'anthropic' | 'openai' | 'google' | 'openrouter';

// Provider-agnostic stream result. Each provider's `streamText` returns a
// `StreamTextResult<TOOLS, OUTPUT>` with provider-specific TOOLS generics
// (web_search vs google_search etc.) that don't unify on their own. The
// caller only touches the surface that's identical across them
// (.toUIMessageStream, .usage, .finishReason), so type-erasing the
// generics is safe.
type AnyStreamResult = StreamTextResult<ToolSet, never>;

// The switch below is the security boundary that decides which `@ai-sdk/*`
// package (and therefore which URL) a turn request can reach. The website
// is untrusted — we never dispatch on an arbitrary provider string it sent
// us. Throw on unknowns rather than falling through.
export function streamProvider(args: {
    provider: string;
    apiKey: string;
    model: string;
    messages: ModelMessage[];
    system?: string;
    params: Record<string, unknown>;
    signal?: AbortSignal;
}): AnyStreamResult {
    const { provider, ...rest } = args;
    switch (provider) {
        case 'anthropic':
            return streamAnthropic(rest) as unknown as AnyStreamResult;
        case 'openai':
            return streamOpenAI(rest) as unknown as AnyStreamResult;
        case 'google':
            return streamGoogle(rest) as unknown as AnyStreamResult;
        case 'openrouter':
            return streamOpenRouter(rest) as unknown as AnyStreamResult;
        default:
            throw new Error(`Unsupported provider: ${provider}`);
    }
}
