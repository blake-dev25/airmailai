import OpenAI from 'openai';
import type {
    CourierAIChunk,
    CourierAIMessage,
    ProviderStreamArgs,
} from '@courierai/shared';
import { makeDebugFetch } from './debug-fetch';
import { foldSourcesIntoText } from './fold-sources';

type Effort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

// Our thinkingLevel vocabulary -> OpenAI's reasoning.effort enum. 'max' has no
// equivalent and clamps to 'xhigh'; 'none'/unset returns undefined to skip.
function toEffort(level: string | undefined): Effort | undefined {
    if (!level || level === 'none') return undefined;
    if (level === 'max') return 'xhigh';
    if (
        level === 'minimal' ||
        level === 'low' ||
        level === 'medium' ||
        level === 'high' ||
        level === 'xhigh'
    ) {
        return level;
    }
    return undefined;
}

function buildInput(
    messages: CourierAIMessage[]
): OpenAI.Responses.ResponseInputItem[] {
    // TODO: hydrate data-attachment parts into input_image/input_file
    // content. Text + Sources-fold only for now.
    return messages.map((msg) => ({
        role: msg.role,
        content: foldSourcesIntoText(msg),
    }));
}

// Hand-rolled OpenAI Responses provider. Maps the Responses SSE to our chunk
// vocabulary. Runs statelessly with store:false (privacy) - web-search URLs
// replay via the Sources text-fold in buildInput, not OpenAI's server store
// (which store:false makes unreachable anyway). See ai_sdk_removal_plan.txt D3.
export async function* streamOpenAI(
    args: ProviderStreamArgs
): AsyncGenerator<CourierAIChunk> {
    const client = new OpenAI({
        apiKey: args.apiKey,
        dangerouslyAllowBrowser: true,
        fetch: makeDebugFetch('openai'),
    });

    const effort = toEffort(args.params.thinkingLevel as string | undefined);
    const maxTokens = (args.params.maxTokens as number | undefined) ?? 8192;

    // OpenAI bundles search + open_page (fetch) into one web_search server
    // tool; the UI surfaces them as a single toggle. Attach if either is on.
    const wireTools = (args.params.tools ?? {}) as Record<
        string,
        string | boolean | undefined
    >;
    const tools: OpenAI.Responses.Tool[] = [];
    if (wireTools.webSearch || wireTools.webFetch) {
        tools.push({ type: 'web_search' });
    }
    if (wireTools.codeExecution) {
        tools.push({ type: 'code_interpreter', container: { type: 'auto' } });
    }

    // code_interpreter stdout/images only stream when explicitly included;
    // without this the call's `outputs` come back null and we'd render an empty
    // Code block.
    const include: OpenAI.Responses.ResponseIncludable[] | undefined =
        wireTools.codeExecution ? ['code_interpreter_call.outputs'] : undefined;

    const stream = await client.responses.create(
        {
            model: args.model,
            input: buildInput(args.messages),
            max_output_tokens: maxTokens,
            ...(args.system ? { instructions: args.system } : {}),
            ...(args.params.temperature !== undefined
                ? { temperature: args.params.temperature as number }
                : {}),
            ...(effort
                ? { reasoning: { effort, summary: 'auto' as const } }
                : {}),
            ...(tools.length ? { tools } : {}),
            ...(include ? { include } : {}),
            store: false,
            stream: true,
        },
        { signal: args.signal }
    );

    // OpenAI streams text/reasoning per output item + content part; bracket each
    // with start/end keyed by `${item_id}:${index}` so the reducer keeps
    // interleaved segments ordered.
    const openText = new Set<string>();
    const openReasoning = new Set<string>();

    try {
        for await (const event of stream) {
            switch (event.type) {
                case 'response.content_part.added': {
                    if (event.part.type === 'output_text') {
                        const id = `${event.item_id}:${event.content_index}`;
                        openText.add(id);
                        yield { type: 'text-start', id };
                    }
                    break;
                }
                case 'response.output_text.delta': {
                    yield {
                        type: 'text-delta',
                        id: `${event.item_id}:${event.content_index}`,
                        delta: event.delta,
                    };
                    break;
                }
                case 'response.output_text.annotation.added': {
                    const ann = event.annotation as {
                        type?: string;
                        url?: string;
                        title?: string;
                    };
                    if (
                        ann.type === 'url_citation' &&
                        typeof ann.url === 'string'
                    ) {
                        yield {
                            type: 'source-url',
                            sourceId: `${event.item_id}:${event.annotation_index}`,
                            url: ann.url,
                            ...(typeof ann.title === 'string'
                                ? { title: ann.title }
                                : {}),
                        };
                    }
                    break;
                }
                case 'response.content_part.done': {
                    const id = `${event.item_id}:${event.content_index}`;
                    if (openText.delete(id)) yield { type: 'text-end', id };
                    break;
                }
                case 'response.reasoning_summary_text.delta': {
                    const id = `${event.item_id}:${event.summary_index}`;
                    if (!openReasoning.has(id)) {
                        openReasoning.add(id);
                        yield { type: 'reasoning-start', id };
                    }
                    yield { type: 'reasoning-delta', id, delta: event.delta };
                    break;
                }
                case 'response.reasoning_summary_text.done': {
                    const id = `${event.item_id}:${event.summary_index}`;
                    if (openReasoning.delete(id)) {
                        yield { type: 'reasoning-end', id };
                    }
                    break;
                }
                case 'response.output_item.added': {
                    if (event.item.type === 'web_search_call') {
                        yield {
                            type: 'tool-call',
                            toolCallId: event.item.id,
                            name: 'web_search',
                        };
                    }
                    // code_interpreter_call is emitted at output_item.done, where
                    // the final code + outputs are present (at `added` code is '').
                    break;
                }
                case 'response.output_item.done': {
                    if (event.item.type === 'web_search_call') {
                        yield {
                            type: 'tool-result',
                            toolCallId: event.item.id,
                        };
                    } else if (event.item.type === 'code_interpreter_call') {
                        const item = event.item;
                        yield {
                            type: 'tool-call',
                            toolCallId: item.id,
                            name: 'code_execution',
                            ...(item.code
                                ? { input: { code: item.code } }
                                : {}),
                        };
                        // outputs hold stdout as `logs` entries (+ image urls we
                        // don't surface yet); join the logs into stdout.
                        const stdout = (item.outputs ?? [])
                            .map((o) => (o.type === 'logs' ? o.logs : ''))
                            .join('');
                        const failed =
                            item.status === 'failed' ||
                            item.status === 'incomplete';
                        yield {
                            type: 'tool-result',
                            toolCallId: item.id,
                            ...(stdout ? { output: { stdout } } : {}),
                            ...(failed
                                ? { errorText: `code execution ${item.status}` }
                                : {}),
                        };
                    }
                    break;
                }
                case 'response.completed': {
                    const u = event.response.usage;
                    yield {
                        type: 'finish',
                        metadata: u
                            ? {
                                  tokens: {
                                      input: u.input_tokens,
                                      output: u.output_tokens,
                                  },
                              }
                            : {},
                    };
                    break;
                }
                case 'error': {
                    throw new Error(event.message ?? 'OpenAI stream error');
                }
            }
        }
    } catch (e) {
        if (args.signal?.aborted) return;
        throw e;
    }
}
