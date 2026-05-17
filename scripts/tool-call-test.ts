import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI, type Tool as GoogleTool } from '@google/genai';
import OpenAI from 'openai';
import { buildOpenAIResponsesToolResults } from '../packages/courierai_ext/providers/tool-results';

type Provider = 'anthropic' | 'google' | 'openai' | 'openrouter';
type ToolName = 'web_search';

interface Args {
    provider: Provider;
    model: string;
    tools: ToolName[];
    input: string;
    replay: boolean;
}

function usage(): never {
    throw new Error(
        [
            'Usage:',
            '  bun scripts/tool-call-test.ts --provider <anthropic|google|openai|openrouter> --model <model-id> --tools <csv> --input <text>',
            '',
            'Example:',
            '  bun scripts/tool-call-test.ts --provider google --model gemini-3-pro-preview --tools web_search --input "hex color"',
        ].join('\n')
    );
}

function readFlag(name: string): string | undefined {
    const idx = process.argv.indexOf(name);
    if (idx < 0) return undefined;
    const value = process.argv[idx + 1];
    if (!value) return undefined;
    return value;
}

function parseProvider(value: string | undefined): Provider {
    if (
        value === 'anthropic' ||
        value === 'google' ||
        value === 'openai' ||
        value === 'openrouter'
    ) {
        return value;
    }
    usage();
}

function parseTools(value: string | undefined): ToolName[] {
    if (!value) return [];
    const parts = value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    const out: ToolName[] = [];
    for (const p of parts) {
        if (p === 'web_search') out.push(p);
        else throw new Error(`Unknown tool: ${p}`);
    }
    return out;
}

function parseArgs(): Args {
    const provider = parseProvider(readFlag('--provider'));
    const model = readFlag('--model');
    const tools = parseTools(readFlag('--tools'));
    const input = readFlag('--input');
    const replay = process.argv.includes('--replay');
    if (!model || !input) usage();
    return { provider, model, tools, input, replay };
}

function getEnv(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`${name} missing from .env`);
    return value;
}

function serializeError(error: unknown): unknown {
    if (!(error instanceof Error)) return error;
    const out: Record<string, unknown> = {
        name: error.name,
        message: error.message,
    };
    for (const key of Object.getOwnPropertyNames(error)) {
        out[key] = (error as unknown as Record<string, unknown>)[key];
    }
    return out;
}

async function callAnthropic(args: Args) {
    const client = new Anthropic({ apiKey: getEnv('ANTHROPIC_API_KEY') });
    const tools: Anthropic.ToolUnion[] = [];
    if (args.tools.includes('web_search')) {
        tools.push({
            type: 'web_search_20260209',
            name: 'web_search',
            max_uses: 5,
        } satisfies Anthropic.Messages.WebSearchTool20260209);
    }
    return client.messages.create({
        model: args.model,
        max_tokens: 4096,
        messages: [{ role: 'user', content: args.input }],
        ...(tools.length ? { tools } : {}),
    });
}

async function callGoogle(args: Args) {
    const client = new GoogleGenAI({ apiKey: getEnv('GOOGLE_API_KEY') });
    const tools: GoogleTool[] = [];
    if (args.tools.includes('web_search')) {
        tools.push({ googleSearch: {} });
    }
    return client.models.generateContent({
        model: args.model,
        contents: [{ role: 'user', parts: [{ text: args.input }] }],
        config: {
            maxOutputTokens: 4096,
            ...(tools.length ? { tools } : {}),
        },
    });
}

async function callOpenAI(args: Args) {
    const client = new OpenAI({ apiKey: getEnv('OPENAI_API_KEY') });
    const tools: OpenAI.Responses.Tool[] = [];
    if (args.tools.includes('web_search')) {
        tools.push({ type: 'web_search' as const });
    }
    return client.responses.create({
        model: args.model,
        input: [{ role: 'user', content: args.input }],
        max_output_tokens: 4096,
        reasoning: {
            effort: 'medium',
            summary: 'auto',
        } satisfies OpenAI.Reasoning,
        ...(tools.length
            ? {
                  tools,
                  include: ['reasoning.encrypted_content' as const],
              }
            : {}),
    });
}

async function callOpenRouter(args: Args) {
    const { OpenRouter } = await import('@openrouter/sdk');
    const client = new OpenRouter({ apiKey: getEnv('OPENROUTER_API_KEY') });
    // Shapes named locally because the @openrouter/sdk types lag runtime
    // (see [[openrouter-api-sdk-quirks]]) — we don't satisfies <SDKType>.
    type OpenRouterWebSearchTool = { type: 'openrouter:web_search' };
    type OpenRouterReasoning = { effort: 'medium'; summary: 'auto' };
    const tools: OpenRouterWebSearchTool[] = [];
    if (args.tools.includes('web_search')) {
        tools.push({ type: 'openrouter:web_search' });
    }
    return client.beta.responses.send({
        responsesRequest: {
            model: args.model,
            input: [{ role: 'user', content: args.input }],
            maxOutputTokens: 4096,
            reasoning: {
                effort: 'medium',
                summary: 'auto',
            } satisfies OpenRouterReasoning,
            include: [
                'reasoning.encrypted_content' as const,
            ] satisfies Array<'reasoning.encrypted_content'>,
            ...(tools.length ? { tools } : {}),
        },
    });
}

// Exercise the multi-turn replay path: take the first response, run it
// through our collector, then re-inject the collected items the same way
// the extension does on a follow-up turn.
async function replayOpenAI(args: Args) {
    const client = new OpenAI({ apiKey: getEnv('OPENAI_API_KEY') });
    const tools: OpenAI.Responses.Tool[] = [{ type: 'web_search' as const }];

    const first = await client.responses.create({
        model: args.model,
        input: [{ role: 'user', content: args.input }],
        max_output_tokens: 4096,
        reasoning: {
            effort: 'medium',
            summary: 'auto',
        } satisfies OpenAI.Reasoning,
        tools,
        include: ['reasoning.encrypted_content'],
    });

    const toolResults = buildOpenAIResponsesToolResults(first);
    console.error('=== first response output items ===');
    console.error(
        JSON.stringify(
            (first as { output: unknown[] }).output.map((o) => {
                const obj = o as Record<string, unknown>;
                return {
                    type: obj.type,
                    id: obj.id,
                    encrypted_len: (obj.encrypted_content as string)?.length,
                    action_type: (obj.action as { type?: string })?.type,
                };
            }),
            null,
            2
        )
    );
    console.error('=== collected toolResults ===');
    console.error(JSON.stringify(toolResults, null, 2));

    const prefix: OpenAI.Responses.ResponseInputItem[] = [];
    for (const tr of toolResults) {
        for (const r of tr.openaiReasoning ?? []) {
            prefix.push({
                type: 'reasoning' as const,
                id: r.id,
                summary: [],
                encrypted_content: r.encryptedContent,
            });
        }
        if (tr.callId) {
            prefix.push({
                type: 'web_search_call' as const,
                id: tr.callId,
                status: 'completed' as const,
                action: { type: 'search' as const, query: '' },
            });
        }
    }

    // Sterile assistant text — match the OpenRouter replay methodology so
    // the model can't cheat by reading URLs out of its own prior reply.
    const followup: OpenAI.Responses.ResponseInputItem[] = [
        { role: 'user' as const, content: args.input },
        ...prefix,
        {
            role: 'assistant' as const,
            content: 'I completed using the tool.',
        },
        {
            role: 'user' as const,
            content:
                'great. without searching again, please print one of the previously returned urls verbatim',
        },
    ];

    const groundTruth: string[] = [];
    for (const item of (first as { output: unknown[] }).output) {
        const content = (item as { content?: unknown[] }).content;
        if (!Array.isArray(content)) continue;
        for (const part of content) {
            const anns = (part as { annotations?: unknown[] }).annotations;
            if (!Array.isArray(anns)) continue;
            for (const a of anns) {
                const aa = a as { type?: string; url?: string };
                if (aa.type === 'url_citation' && aa.url)
                    groundTruth.push(aa.url);
            }
        }
    }
    console.error('=== ground-truth URLs from first response ===');
    console.error(JSON.stringify(groundTruth, null, 2));

    const resp = await client.responses.create({
        model: args.model,
        input: followup,
        max_output_tokens: 4096,
        reasoning: {
            effort: 'medium',
            summary: 'auto',
        } satisfies OpenAI.Reasoning,
        tools,
        include: ['reasoning.encrypted_content'],
    });
    const r = resp as {
        usage?: { input_tokens?: number };
        output: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    };
    const reply =
        r.output
            .flatMap((o) => o.content ?? [])
            .find((c) => c.type === 'output_text')?.text ?? '';
    return {
        native: { tokens: r.usage?.input_tokens ?? 0, reply },
    };
}

// Google replay: text-block strategy. Signed-replay of toolCall/toolResponse
// parts authorizes the model turn but doesn't carry the grounded URL set —
// `groundingMetadata` is output-only and `thoughtSignature` is a thought-
// continuity token, not an encrypted state blob. So we mirror what we do for
// OpenRouter: append a `Sources:` block to the assistant's prior text and
// let the model re-read its own message.
async function replayGoogle(args: Args) {
    const client = new GoogleGenAI({ apiKey: getEnv('GOOGLE_API_KEY') });
    const tools: GoogleTool[] = [{ googleSearch: {} }];

    const first = await client.models.generateContent({
        model: args.model,
        contents: [{ role: 'user', parts: [{ text: args.input }] }],
        config: { maxOutputTokens: 4096, tools },
    });

    const firstCandidate = first.candidates?.[0];
    const assistantText = (firstCandidate?.content?.parts ?? [])
        .map((p) => p.text ?? '')
        .join('');

    const groundTruth: Array<{ url: string; title?: string }> = [];
    const grounding = (
        firstCandidate as
            | {
                  groundingMetadata?: {
                      groundingChunks?: Array<{
                          web?: { uri?: string; title?: string };
                      }>;
                  };
              }
            | undefined
    )?.groundingMetadata;
    for (const gc of grounding?.groundingChunks ?? []) {
        if (typeof gc.web?.uri === 'string') {
            groundTruth.push({
                url: gc.web.uri,
                ...(typeof gc.web.title === 'string'
                    ? { title: gc.web.title }
                    : {}),
            });
        }
    }

    console.error(
        '=== first turn ===',
        JSON.stringify(
            {
                assistantTextLen: assistantText.length,
                groundTruthCount: groundTruth.length,
            },
            null,
            2
        )
    );
    console.error('=== ground-truth sources ===');
    console.error(JSON.stringify(groundTruth, null, 2));

    if (!groundTruth.length) {
        throw new Error(
            'No grounded sources captured — model may not have searched'
        );
    }

    // Mirror providers/openrouter.ts:withSourcesBlock — markdown-numbered list
    // appended to the assistant turn so the model can re-read URLs/titles.
    const sourceLines = groundTruth.map((s, i) =>
        s.title ? `${i + 1}. [${s.title}](${s.url})` : `${i + 1}. ${s.url}`
    );
    const replayedAssistant =
        (assistantText ? assistantText + '\n\n' : '') +
        'Sources:\n' +
        sourceLines.join('\n');

    const followupQuestion =
        'great. without searching again, please print ALL of the URLs you returned in your previous response, verbatim, one per line.';

    const followup = await client.models.generateContent({
        model: args.model,
        contents: [
            { role: 'user', parts: [{ text: args.input }] },
            { role: 'model', parts: [{ text: replayedAssistant }] },
            { role: 'user', parts: [{ text: followupQuestion }] },
        ],
        config: { maxOutputTokens: 4096, tools },
    });

    const reply = (followup.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? '')
        .join('');

    const urlsPrintedVerbatim = groundTruth
        .map((s) => s.url)
        .filter((u) => reply.includes(u));

    return {
        followupTokens: followup.usageMetadata?.promptTokenCount ?? 0,
        groundTruthCount: groundTruth.length,
        urlsPrintedVerbatim: urlsPrintedVerbatim.length,
        verbatimMatches: urlsPrintedVerbatim,
        reply,
    };
}

// OpenRouter replay: direct HTTP (the SDK silently drops fields like
// `encrypted_content` on reasoning items). Captures reasoning items with
// encrypted_content + openrouter:web_search items + url_citation annotations,
// then replays them on the follow-up with sterile assistant text. The
// follow-up asks for a URL verbatim — clearest signal of whether the actual
// search context survived the round trip.
async function replayOpenRouter(args: Args) {
    const headers = {
        Authorization: `Bearer ${getEnv('OPENROUTER_API_KEY')}`,
        'Content-Type': 'application/json',
    };
    const call = async (body: Record<string, unknown>) => {
        const r = await fetch('https://openrouter.ai/api/v1/responses', {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });
        return r.json() as Promise<{
            output: Array<Record<string, unknown>>;
            usage?: { input_tokens?: number };
            error?: unknown;
        }>;
    };

    const first = await call({
        model: args.model,
        input: [{ role: 'user', content: args.input }],
        max_output_tokens: 4096,
        tools: [{ type: 'openrouter:web_search' }],
        include: ['reasoning.encrypted_content'],
        reasoning: { effort: 'medium', summary: 'auto' },
    });

    console.error('=== first response output item summary ===');
    console.error(
        JSON.stringify(
            first.output.map((o) => ({
                type: o.type,
                id: o.id,
                hasEncrypted: !!o.encrypted_content,
                encryptedLen: (o.encrypted_content as string)?.length,
                annotationsCount: Array.isArray(o.content)
                    ? (o.content as Array<{ annotations?: unknown[] }>).reduce(
                          (n, c) =>
                              n +
                              (Array.isArray(c.annotations)
                                  ? c.annotations.length
                                  : 0),
                          0
                      )
                    : 0,
            })),
            null,
            2
        )
    );

    const groundTruth: string[] = [];
    for (const item of first.output) {
        const content = item.content as
            | Array<{ annotations?: unknown[] }>
            | undefined;
        if (!Array.isArray(content)) continue;
        for (const part of content) {
            if (!Array.isArray(part.annotations)) continue;
            for (const a of part.annotations) {
                const aa = a as { type?: string; url?: string };
                if (aa.type === 'url_citation' && aa.url)
                    groundTruth.push(aa.url);
            }
        }
    }
    console.error('=== ground-truth URLs ===');
    console.error(JSON.stringify(groundTruth, null, 2));

    // Build two replay strategies for side-by-side comparison:
    //
    //   A) "encrypted": walk output, replay reasoning items (with
    //      encrypted_content) and openrouter:web_search items verbatim. Sterile
    //      assistant text. This is what we'd get by switching to direct HTTP.
    //   B) "text-block": stay on SDK-compatible shape (no reasoning items),
    //      but append a "[Search returned: <url1>, <url2>...]" block to the
    //      otherwise sterile assistant text. Sources persisted in our chat
    //      history are sufficient input.
    //
    // Both face the same URL-verbatim prompt with sterile model text otherwise.
    const replayItemsEncrypted: Array<Record<string, unknown>> = [];
    for (const item of first.output) {
        if (item.type === 'reasoning' && item.encrypted_content) {
            replayItemsEncrypted.push({
                type: 'reasoning',
                id: item.id,
                summary: [],
                encrypted_content: item.encrypted_content,
            });
        } else if (item.type === 'openrouter:web_search') {
            replayItemsEncrypted.push({
                type: 'openrouter:web_search',
                ...(item.id ? { id: item.id } : {}),
                status: 'completed',
                action: item.action ?? { type: 'search', query: '' },
            });
        }
    }

    const followupQuestion =
        'great. without searching again, please print one of the previously returned urls verbatim';

    const followupEncrypted = [
        { role: 'user', content: args.input },
        ...replayItemsEncrypted,
        {
            type: 'message',
            id: 'msg_replayed',
            role: 'assistant',
            status: 'completed',
            content: [
                {
                    type: 'output_text',
                    text: 'I completed using the tool.',
                    annotations: [],
                },
            ],
        },
        { role: 'user', content: followupQuestion },
    ];

    const sourcesBlock = groundTruth.length
        ? '\n\nSources:\n' +
          groundTruth.map((u, i) => `${i + 1}. ${u}`).join('\n')
        : '';
    const followupTextBlock = [
        { role: 'user', content: args.input },
        {
            role: 'assistant',
            content: 'I completed using the tool.' + sourcesBlock,
        },
        { role: 'user', content: followupQuestion },
    ];

    const [secondEnc, secondTxt] = await Promise.all([
        call({
            model: args.model,
            input: followupEncrypted,
            max_output_tokens: 4096,
            tools: [{ type: 'openrouter:web_search' }],
            include: ['reasoning.encrypted_content'],
            reasoning: { effort: 'medium', summary: 'auto' },
        }),
        call({
            model: args.model,
            input: followupTextBlock,
            max_output_tokens: 4096,
            tools: [{ type: 'openrouter:web_search' }],
        }),
    ]);

    const reply = (r: typeof secondEnc) =>
        (
            (r.output
                .flatMap((o) =>
                    Array.isArray(o.content)
                        ? (o.content as Array<{ type?: string; text?: string }>)
                        : []
                )
                .find((c) => c.type === 'output_text')?.text as string) ?? ''
        ).slice(0, 400);

    return {
        firstTokens: first.usage?.input_tokens ?? 0,
        encrypted: {
            tokens: secondEnc.usage?.input_tokens ?? 0,
            reply: reply(secondEnc),
            error: secondEnc.error,
        },
        textBlock: {
            tokens: secondTxt.usage?.input_tokens ?? 0,
            reply: reply(secondTxt),
            error: secondTxt.error,
        },
    };
}

async function main(): Promise<void> {
    const args = parseArgs();
    if (args.replay) {
        if (args.provider === 'openai') {
            const response = await replayOpenAI(args);
            console.log(JSON.stringify(response, null, 2));
            return;
        }
        if (args.provider === 'openrouter') {
            const response = await replayOpenRouter(args);
            console.log(JSON.stringify(response, null, 2));
            return;
        }
        if (args.provider === 'google') {
            const response = await replayGoogle(args);
            console.log(JSON.stringify(response, null, 2));
            return;
        }
        throw new Error('--replay only supported for openai/openrouter/google');
    }
    const response =
        args.provider === 'anthropic'
            ? await callAnthropic(args)
            : args.provider === 'google'
              ? await callGoogle(args)
              : args.provider === 'openai'
                ? await callOpenAI(args)
                : await callOpenRouter(args);

    console.log(JSON.stringify(response, null, 2));
}

main().catch((error) => {
    console.error(JSON.stringify(serializeError(error), null, 2));
    process.exit(1);
});
