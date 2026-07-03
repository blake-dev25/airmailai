import OpenAI from 'openai';
import type {
    CourierAIChunk,
    CourierAIMessage,
    ProviderStreamArgs,
} from '@courierai/shared';
import {
    type ProviderReplicas,
    type ResolvedAttachment,
    resolveAttachments,
} from './attachments';
import { makeDebugFetch } from './debug-fetch';
import { foldReplayIntoText } from './fold-replay';

type Effort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

function toEffort(level: string | undefined): Effort | undefined {
    if (!level) return undefined;
    if (level === 'max') return 'xhigh';
    if (
        level === 'none' ||
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

function isContainerExpired(e: unknown): boolean {
    return (
        e instanceof OpenAI.APIError &&
        e.status === 400 &&
        /container is expired/i.test(e.message ?? '')
    );
}

function decodeBase64Text(base64: string): string {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
}

function buildContent(
    msg: CourierAIMessage,
    atts: ResolvedAttachment[],
    codeExecEnabled: boolean,
    sandboxFileIds: string[]
): string | OpenAI.Responses.ResponseInputContent[] {
    const text = foldReplayIntoText(msg);
    const content: OpenAI.Responses.ResponseInputContent[] = [];
    for (const att of atts) {
        if (att.kind === 'provider') {
            if (att.providerId !== 'openai') continue;
            if (att.mediaType.startsWith('image/')) {
                content.push({
                    type: 'input_image',
                    detail: 'auto',
                    file_id: att.fileId,
                });
            } else if (msg.role === 'user' && codeExecEnabled) {
                sandboxFileIds.push(att.fileId);
            } else if (att.mediaType.startsWith('text/') && att.base64) {
                content.push({
                    type: 'input_text',
                    text: decodeBase64Text(att.base64),
                });
            } else {
                content.push({ type: 'input_file', file_id: att.fileId });
            }
            continue;
        }
        const dataUrl = `data:${att.mediaType};base64,${att.base64}`;
        if (att.mediaType.startsWith('image/')) {
            content.push({
                type: 'input_image',
                detail: 'auto',
                image_url: dataUrl,
            });
        } else if (att.mediaType.startsWith('text/')) {
            content.push({
                type: 'input_text',
                text: decodeBase64Text(att.base64),
            });
        } else {
            content.push({
                type: 'input_file',
                filename: att.filename,
                file_data: dataUrl,
            });
        }
    }
    if (content.length === 0) return text;
    if (text) content.unshift({ type: 'input_text', text });
    return content;
}

interface BuiltInput {
    input: OpenAI.Responses.ResponseInputItem[];
    sandboxAllFileIds: string[];
    sandboxLastTurnFileIds: string[];
}

function buildInput(
    messages: CourierAIMessage[],
    blobs: Record<string, { mediaType: string; base64: string }>,
    replicas: ProviderReplicas | undefined,
    codeExecEnabled: boolean
): BuiltInput {
    const input: OpenAI.Responses.ResponseInputItem[] = [];
    const sandboxAllFileIds: string[] = [];
    let sandboxLastTurnFileIds: string[] = [];
    for (const msg of messages) {
        const atts = resolveAttachments(msg, blobs, replicas);
        const sandboxFileIds: string[] = [];
        input.push({
            role: msg.role,
            content: buildContent(msg, atts, codeExecEnabled, sandboxFileIds),
        });
        if (msg.role === 'user') {
            sandboxAllFileIds.push(...sandboxFileIds);
            sandboxLastTurnFileIds = sandboxFileIds;
        }
    }
    return { input, sandboxAllFileIds, sandboxLastTurnFileIds };
}

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

    const wireTools = (args.params.tools ?? {}) as Record<
        string,
        string | boolean | undefined
    >;
    const reuseContainerId =
        typeof args.params.container === 'string'
            ? args.params.container
            : undefined;
    const codeExecEnabled = !!wireTools.codeExecution;
    const replicas: ProviderReplicas | undefined =
        args.providerFiles && Object.keys(args.providerFiles).length
            ? { providerId: 'openai', files: args.providerFiles }
            : undefined;
    const built = buildInput(
        args.messages,
        args.blobs ?? {},
        replicas,
        codeExecEnabled
    );

    function buildTools(reuse: boolean): OpenAI.Responses.Tool[] {
        const tools: OpenAI.Responses.Tool[] = [];
        if (wireTools.webSearch || wireTools.webFetch) {
            tools.push({ type: 'web_search' });
        }
        if (codeExecEnabled) {
            tools.push({
                type: 'shell',
                environment:
                    reuse && reuseContainerId
                        ? {
                              type: 'container_reference',
                              container_id: reuseContainerId,
                          }
                        : {
                              type: 'container_auto',
                              memory_limit: '1g',
                              ...(built.sandboxAllFileIds.length
                                  ? { file_ids: built.sandboxAllFileIds }
                                  : {}),
                          },
            });
        }
        return tools;
    }

    function createStream(reuse: boolean) {
        const tools = buildTools(reuse);
        return client.responses.create(
            {
                model: args.model,
                input: built.input,
                max_output_tokens: maxTokens,
                ...(args.system ? { instructions: args.system } : {}),
                ...(args.params.temperature !== undefined
                    ? { temperature: args.params.temperature as number }
                    : {}),
                ...(effort
                    ? { reasoning: { effort, summary: 'auto' as const } }
                    : {}),
                ...(tools.length ? { tools } : {}),
                store: false,
                stream: true,
            },
            { signal: args.signal }
        );
    }

    async function attachWarmContainerFiles(containerId: string) {
        for (const fileId of built.sandboxLastTurnFileIds) {
            await client.containers.files.create(containerId, {
                file_id: fileId,
            });
        }
    }

    async function openStream() {
        if (!reuseContainerId) return await createStream(false);
        try {
            await attachWarmContainerFiles(reuseContainerId);
            return await createStream(true);
        } catch (e) {
            const containerGone =
                isContainerExpired(e) ||
                (e instanceof OpenAI.APIError && e.status === 404);
            if (containerGone) return await createStream(false);
            throw e;
        }
    }
    const stream = await openStream();

    const openText = new Set<string>();
    const openReasoning = new Set<string>();
    const seenSourceIds = new Set<string>();
    let containerId: string | undefined;

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
                        file_id?: string;
                        filename?: string;
                        start_index?: number;
                        end_index?: number;
                    };
                    const textId = `${event.item_id}:${event.content_index}`;
                    const span =
                        typeof ann.start_index === 'number' &&
                        typeof ann.end_index === 'number'
                            ? {
                                  textStart: ann.start_index,
                                  textEnd: ann.end_index,
                              }
                            : {};
                    if (
                        ann.type === 'url_citation' &&
                        typeof ann.url === 'string'
                    ) {
                        if (!seenSourceIds.has(ann.url)) {
                            seenSourceIds.add(ann.url);
                            yield {
                                type: 'source-url',
                                sourceId: ann.url,
                                url: ann.url,
                                ...(typeof ann.title === 'string'
                                    ? { title: ann.title }
                                    : {}),
                            };
                        }
                        yield {
                            type: 'citation',
                            sourceId: ann.url,
                            textId,
                            ...span,
                        };
                    } else if (
                        ann.type === 'container_file_citation' &&
                        typeof ann.file_id === 'string'
                    ) {
                        const sourceId = `file:${ann.file_id}`;
                        if (!seenSourceIds.has(sourceId)) {
                            seenSourceIds.add(sourceId);
                            yield {
                                type: 'source-document',
                                sourceId,
                                ...(typeof ann.filename === 'string'
                                    ? { title: ann.filename }
                                    : {}),
                            };
                        }
                        yield {
                            type: 'citation',
                            sourceId,
                            textId,
                            ...span,
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
                    break;
                }
                case 'response.output_item.done': {
                    if (event.item.type === 'web_search_call') {
                        yield {
                            type: 'tool-result',
                            toolCallId: event.item.id,
                        };
                    } else if (event.item.type === 'shell_call') {
                        const item = event.item;
                        if (item.environment?.type === 'container_reference') {
                            containerId = item.environment.container_id;
                        }
                        const code = item.action.commands.join('\n');
                        yield {
                            type: 'tool-call',
                            toolCallId: item.call_id,
                            name: 'code_execution',
                            ...(code ? { input: { code } } : {}),
                        };
                        if (item.status === 'incomplete') {
                            yield {
                                type: 'tool-result',
                                toolCallId: item.call_id,
                                errorText: 'code execution incomplete',
                            };
                        }
                    } else if (event.item.type === 'shell_call_output') {
                        const item = event.item;
                        const stdout = item.output
                            .map((o) => o.stdout)
                            .join('');
                        const stderr = item.output
                            .map((o) => o.stderr)
                            .join('');
                        const timedOut = item.output.some(
                            (o) => o.outcome.type === 'timeout'
                        );
                        const output =
                            stdout || stderr
                                ? {
                                      ...(stdout ? { stdout } : {}),
                                      ...(stderr ? { stderr } : {}),
                                  }
                                : undefined;
                        const errorText =
                            item.status === 'incomplete'
                                ? 'code execution incomplete'
                                : timedOut
                                  ? 'code execution timed out'
                                  : undefined;
                        yield {
                            type: 'tool-result',
                            toolCallId: item.call_id,
                            ...(output ? { output } : {}),
                            ...(errorText ? { errorText } : {}),
                        };
                    }
                    break;
                }
                case 'response.completed':
                case 'response.incomplete': {
                    const u = event.response.usage;
                    const stopReason =
                        event.type === 'response.incomplete'
                            ? event.response.incomplete_details?.reason ===
                              'content_filter'
                                ? ('content-filter' as const)
                                : ('length' as const)
                            : undefined;
                    yield {
                        type: 'finish',
                        metadata: {
                            ...(u
                                ? {
                                      tokens: {
                                          input: u.input_tokens,
                                          output: u.output_tokens,
                                      },
                                  }
                                : {}),
                            ...(stopReason ? { stopReason } : {}),
                        },
                        ...(containerId
                            ? {
                                  containerId,
                                  containerExpiresAt: new Date(
                                      Date.now() + 20 * 60 * 1000
                                  ).toISOString(),
                              }
                            : {}),
                    };
                    break;
                }
                case 'response.failed': {
                    throw new Error(
                        event.response.error?.message ??
                            'OpenAI response failed'
                    );
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
