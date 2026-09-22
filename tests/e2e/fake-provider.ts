import type { ProviderKey } from './models';

export const FAKE_REPLY_TEXT = 'pipeline';

export const PROVIDER_HOSTS = [
    'api.anthropic.com',
    'api.openai.com',
    'generativelanguage.googleapis.com',
    'openrouter.ai',
];

export interface FakeProviderStream {
    preamble: string;
    content: string;
}

export interface FakeProviderMarks {
    url: string;
    requestAt: number;
    firstByteAt: number;
}

function sse(event: string | null, data: unknown): string {
    const eventLine = event ? `event: ${event}\n` : '';
    return `${eventLine}data: ${JSON.stringify(data)}\n\n`;
}

function anthropicStream(model: string): FakeProviderStream {
    return {
        preamble:
            sse('message_start', {
                type: 'message_start',
                message: {
                    id: 'msg_fake',
                    type: 'message',
                    role: 'assistant',
                    model,
                    content: [],
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: 1, output_tokens: 1 },
                },
            }) +
            sse('content_block_start', {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: '' },
            }),
        content:
            sse('content_block_delta', {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: FAKE_REPLY_TEXT },
            }) +
            sse('content_block_stop', {
                type: 'content_block_stop',
                index: 0,
            }) +
            sse('message_delta', {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn', stop_sequence: null },
                usage: { output_tokens: 1 },
            }) +
            sse('message_stop', { type: 'message_stop' }),
    };
}

const RESPONSES_ITEM_ID = 'msg_fake';

function responsesUsage() {
    return {
        input_tokens: 1,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 1,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 2,
    };
}

function responsesOutputItem(status: 'in_progress' | 'completed') {
    return {
        id: RESPONSES_ITEM_ID,
        type: 'message',
        status,
        role: 'assistant',
        content:
            status === 'completed'
                ? [
                      {
                          type: 'output_text',
                          text: FAKE_REPLY_TEXT,
                          annotations: [],
                          logprobs: [],
                      },
                  ]
                : [],
    };
}

function responsesCompletedResponse(model: string) {
    const createdAt = Math.floor(Date.now() / 1000);
    return {
        id: 'resp_fake',
        object: 'response',
        created_at: createdAt,
        completed_at: createdAt,
        status: 'completed',
        background: false,
        error: null,
        incomplete_details: null,
        instructions: null,
        max_output_tokens: null,
        max_tool_calls: null,
        model,
        output: [responsesOutputItem('completed')],
        parallel_tool_calls: true,
        previous_response_id: null,
        prompt_cache_key: null,
        reasoning: null,
        safety_identifier: null,
        service_tier: null,
        store: false,
        temperature: null,
        frequency_penalty: null,
        presence_penalty: null,
        tool_choice: 'auto',
        tools: [],
        top_logprobs: null,
        top_p: null,
        truncation: null,
        usage: responsesUsage(),
        user: null,
        metadata: null,
    };
}

function responsesTextDelta(sequenceNumber: number) {
    return sse('response.output_text.delta', {
        type: 'response.output_text.delta',
        sequence_number: sequenceNumber,
        item_id: RESPONSES_ITEM_ID,
        output_index: 0,
        content_index: 0,
        delta: FAKE_REPLY_TEXT,
        logprobs: [],
    });
}

function responsesCompleted(model: string, sequenceNumber: number) {
    return sse('response.completed', {
        type: 'response.completed',
        sequence_number: sequenceNumber,
        response: responsesCompletedResponse(model),
    });
}

function openaiStream(model: string): FakeProviderStream {
    return {
        preamble: sse('response.content_part.added', {
            type: 'response.content_part.added',
            sequence_number: 0,
            item_id: RESPONSES_ITEM_ID,
            output_index: 0,
            content_index: 0,
            part: {
                type: 'output_text',
                text: '',
                annotations: [],
                logprobs: [],
            },
        }),
        content:
            responsesTextDelta(1) +
            sse('response.content_part.done', {
                type: 'response.content_part.done',
                sequence_number: 2,
                item_id: RESPONSES_ITEM_ID,
                output_index: 0,
                content_index: 0,
                part: {
                    type: 'output_text',
                    text: FAKE_REPLY_TEXT,
                    annotations: [],
                    logprobs: [],
                },
            }) +
            responsesCompleted(model, 3),
    };
}

function openrouterStream(model: string): FakeProviderStream {
    return {
        preamble: '',
        content: responsesTextDelta(0) + responsesCompleted(model, 1),
    };
}

function googleStream(model: string): FakeProviderStream {
    return {
        preamble: '',
        content: sse(null, {
            candidates: [
                {
                    content: {
                        parts: [{ text: FAKE_REPLY_TEXT }],
                        role: 'model',
                    },
                    finishReason: 'STOP',
                    index: 0,
                },
            ],
            usageMetadata: {
                promptTokenCount: 1,
                candidatesTokenCount: 1,
                totalTokenCount: 2,
            },
            modelVersion: model,
        }),
    };
}

export function fakeProviderStream(
    provider: ProviderKey,
    model: string
): FakeProviderStream {
    switch (provider) {
        case 'anthropic':
            return anthropicStream(model);
        case 'openai':
            return openaiStream(model);
        case 'google':
            return googleStream(model);
        case 'openrouter':
            return openrouterStream(model);
    }
}
