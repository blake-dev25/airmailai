import { PROVIDER_ENV } from './env';
import type {
    AirmailAIChunk,
    AirmailAIMessage,
    ProviderStream,
} from '../../packages/shared/src/messages';
import { PROVIDERS } from '../../packages/airmailai_web/src/lib/models';
import { PROVIDER_MODELS, type ProviderKey } from './models';
import {
    TTFT_MAX_TOKENS,
    TTFT_PROMPT,
    type TtftWorkerMode,
    type TtftWorkerResult,
} from './ttft-shared';

interface Thinking {
    level: string;
    adaptive: boolean;
}

function lowestThinking(
    provider: ProviderKey,
    model: string
): Thinking | undefined {
    if (provider === 'openrouter') return { level: 'none', adaptive: false };
    const params = PROVIDERS.find((p) => p.id === provider)?.models.find(
        (m) => m.id === model
    )?.params;
    if (!params) throw new Error(`${provider}/${model} is not in PROVIDERS`);
    if (!params.thinking) return undefined;
    return {
        level: params.thinking.levels[0],
        adaptive: params.thinking.adaptive !== undefined,
    };
}

async function loadProvider(provider: ProviderKey): Promise<ProviderStream> {
    switch (provider) {
        case 'anthropic':
            return (
                await import('../../packages/airmailai_ext/providers/anthropic')
            ).streamAnthropic;
        case 'openai':
            return (
                await import('../../packages/airmailai_ext/providers/openai')
            ).streamOpenAI;
        case 'google':
            return (
                await import('../../packages/airmailai_ext/providers/google')
            ).streamGoogle;
        case 'openrouter':
            return (
                await import('../../packages/airmailai_ext/providers/openrouter')
            ).streamOpenRouter;
    }
}

function isContentChunk(chunk: AirmailAIChunk): boolean {
    return (
        (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') &&
        chunk.delta.length > 0
    );
}

async function measureExtImport(
    provider: ProviderKey,
    model: string,
    apiKey: string,
    thinking: Thinking | undefined
): Promise<TtftWorkerResult> {
    const stream = await loadProvider(provider);
    const messages: AirmailAIMessage[] = [
        {
            id: crypto.randomUUID(),
            role: 'user',
            parts: [{ type: 'text', text: TTFT_PROMPT, state: 'done' }],
            metadata: { createdAt: Date.now() },
        },
    ];
    const params = {
        maxTokens: TTFT_MAX_TOKENS,
        ...(thinking
            ? {
                  thinkingLevel: thinking.level,
                  adaptiveThinking: thinking.adaptive,
              }
            : {}),
        tools: {},
        tagOpenRouterRequests: false,
    };

    const start = performance.now();
    let firstContentMs: number | undefined;
    for await (const chunk of stream({ apiKey, model, messages, params })) {
        if (firstContentMs === undefined && isContentChunk(chunk)) {
            firstContentMs = performance.now() - start;
        }
    }
    if (firstContentMs === undefined) {
        throw new Error(`${provider}: stream ended without any content`);
    }
    return { firstContentMs };
}

interface RawRequest {
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
    isContentEvent: (event: unknown) => boolean;
}

interface AnthropicEvent {
    type?: string;
    delta?: { text?: string; thinking?: string };
}

interface ResponsesEvent {
    type?: string;
    delta?: string;
}

interface GoogleEvent {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
}

function responsesEffort(level: string): string {
    return level === 'max' ? 'xhigh' : level;
}

function anthropicThinking(
    thinking: Thinking | undefined
): Record<string, unknown> {
    if (!thinking || thinking.level === 'none') return {};
    if (!thinking.adaptive) {
        throw new Error(
            'raw anthropic request: non-adaptive thinking needs a 2048+ token budget, which a TTFT call cannot spare'
        );
    }
    return {
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: thinking.level },
    };
}

function googleThinking(
    model: string,
    thinking: Thinking | undefined
): Record<string, unknown> {
    if (!thinking || thinking.level === 'none') return {};
    if (model.includes('2.5')) {
        throw new Error(
            'raw google request: thinkingBudget-era (2.5) models are not supported'
        );
    }
    const level =
        thinking.level === 'max' || thinking.level === 'xhigh'
            ? 'HIGH'
            : thinking.level.toUpperCase();
    return { thinkingConfig: { thinkingLevel: level, includeThoughts: true } };
}

function isResponsesContentEvent(event: unknown): boolean {
    const e = event as ResponsesEvent;
    return (
        (e.type === 'response.output_text.delta' ||
            e.type === 'response.reasoning_summary_text.delta') &&
        !!e.delta
    );
}

function rawRequest(
    provider: ProviderKey,
    model: string,
    apiKey: string,
    thinking: Thinking | undefined
): RawRequest {
    switch (provider) {
        case 'anthropic':
            return {
                url: 'https://api.anthropic.com/v1/messages',
                headers: {
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                },
                body: {
                    model,
                    max_tokens: TTFT_MAX_TOKENS,
                    messages: [{ role: 'user', content: TTFT_PROMPT }],
                    ...anthropicThinking(thinking),
                    stream: true,
                },
                isContentEvent: (event) => {
                    const e = event as AnthropicEvent;
                    return (
                        e.type === 'content_block_delta' &&
                        (!!e.delta?.text || !!e.delta?.thinking)
                    );
                },
            };
        case 'openai':
            return {
                url: 'https://api.openai.com/v1/responses',
                headers: { authorization: `Bearer ${apiKey}` },
                body: {
                    model,
                    input: TTFT_PROMPT,
                    max_output_tokens: TTFT_MAX_TOKENS,
                    ...(thinking
                        ? {
                              reasoning: {
                                  effort: responsesEffort(thinking.level),
                                  summary: 'auto',
                              },
                          }
                        : {}),
                    store: false,
                    stream: true,
                },
                isContentEvent: isResponsesContentEvent,
            };
        case 'google':
            return {
                url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
                headers: { 'x-goog-api-key': apiKey },
                body: {
                    contents: [
                        { role: 'user', parts: [{ text: TTFT_PROMPT }] },
                    ],
                    generationConfig: {
                        maxOutputTokens: TTFT_MAX_TOKENS,
                        ...googleThinking(model, thinking),
                    },
                },
                isContentEvent: (event) => {
                    const e = event as GoogleEvent;
                    return !!e.candidates?.[0]?.content?.parts?.some(
                        (p) => typeof p.text === 'string' && p.text.length > 0
                    );
                },
            };
        case 'openrouter':
            return {
                url: 'https://openrouter.ai/api/v1/responses',
                headers: { authorization: `Bearer ${apiKey}` },
                body: {
                    model,
                    input: TTFT_PROMPT,
                    max_output_tokens: TTFT_MAX_TOKENS,
                    ...(thinking
                        ? {
                              reasoning:
                                  thinking.level === 'none'
                                      ? { enabled: false }
                                      : {
                                            effort: responsesEffort(
                                                thinking.level
                                            ),
                                            summary: 'auto',
                                        },
                          }
                        : {}),
                    stream: true,
                },
                isContentEvent: isResponsesContentEvent,
            };
    }
}

async function* sseEvents(
    body: ReadableStream<Uint8Array>
): AsyncGenerator<unknown> {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const bytes of body) {
        buffer += decoder.decode(bytes, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
            const line = buffer.slice(0, newline).trimEnd();
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf('\n');
            if (!line.startsWith('data:')) continue;
            const data = line.slice('data:'.length).trim();
            if (!data || data === '[DONE]') continue;
            yield JSON.parse(data);
        }
    }
}

async function measureRaw(
    provider: ProviderKey,
    model: string,
    apiKey: string,
    thinking: Thinking | undefined
): Promise<TtftWorkerResult> {
    const request = rawRequest(provider, model, apiKey, thinking);
    const start = performance.now();
    const res = await fetch(request.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...request.headers },
        body: JSON.stringify(request.body),
    });
    const headersMs = performance.now() - start;
    if (!res.ok || !res.body) {
        throw new Error(`${provider}: HTTP ${res.status} ${await res.text()}`);
    }
    let firstContentMs: number | undefined;
    for await (const event of sseEvents(res.body)) {
        if (firstContentMs === undefined && request.isContentEvent(event)) {
            firstContentMs = performance.now() - start;
        }
    }
    if (firstContentMs === undefined) {
        throw new Error(`${provider}: stream ended without any content`);
    }
    return { firstContentMs, headersMs };
}

function usage(): never {
    console.error(
        'usage: bun tests/e2e/ttft-worker.ts <ext-import|raw> <anthropic|openai|google|openrouter>'
    );
    process.exit(1);
}

async function main(): Promise<void> {
    const [mode, provider] = process.argv.slice(2);
    if (mode !== 'ext-import' && mode !== 'raw') usage();
    if (!provider || !(provider in PROVIDER_MODELS)) usage();
    const key = provider as ProviderKey;
    const apiKey = process.env[PROVIDER_ENV[key]];
    if (!apiKey) throw new Error(`${PROVIDER_ENV[key]} missing from .env`);
    const model = PROVIDER_MODELS[key].chat;
    const thinking = lowestThinking(key, model);
    const result =
        (mode as TtftWorkerMode) === 'raw'
            ? await measureRaw(key, model, apiKey, thinking)
            : await measureExtImport(key, model, apiKey, thinking);
    console.log(JSON.stringify(result));
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
