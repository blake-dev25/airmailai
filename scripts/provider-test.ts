// *** Isolation harness for the hand-rolled providers. Exercises a provider's
// SSE -> CourierAIChunk mapping for a chosen server tool (web_search /
// web_fetch / code_execution), and the stateless text-fold replay round-trip
// (all tools, all providers) - without touching background.ts.
//
//   bun scripts/provider-test.ts --provider anthropic --model claude-haiku-4-5
//   bun scripts/provider-test.ts --provider openai    --tool web_fetch
//   bun scripts/provider-test.ts --provider google    --tool code_execution --dump
//
// --dump prints every CourierAIChunk as it streams
import type {
    CourierAIChunk,
    CourierAIMessage,
    CourierAIPart,
    CourierAISourceUrlPart,
    CourierAIToolPart,
    ProviderStream,
} from '@courierai/shared';
import {
    PROVIDERS,
    type ThinkingLevel,
} from '../packages/courierai_web/src/lib/models';

type ProviderName = 'openai' | 'anthropic' | 'google' | 'openrouter';
type ToolName = 'web_search' | 'web_fetch' | 'code_execution';
type CodeExecPart = Extract<CourierAIToolPart, { name: 'code_execution' }>;

const PROVIDER_DEFAULTS: Record<ProviderName, { env: string; model: string }> =
    {
        openai: { env: 'OPENAI_API_KEY', model: 'gpt-5.5' },
        anthropic: { env: 'ANTHROPIC_API_KEY', model: 'claude-haiku-4-5' },
        google: { env: 'GOOGLE_API_KEY', model: 'gemini-3.5-flash' },
        openrouter: { env: 'OPENROUTER_API_KEY', model: 'openai/gpt-5.5' },
    };

const TOOL_WIRE: Record<
    ProviderName,
    Record<ToolName, string | boolean | null>
> = {
    openai: { web_search: true, web_fetch: true, code_execution: true },
    anthropic: {
        web_search: 'web_search_20260209',
        web_fetch: 'web_fetch_20260209',
        code_execution: 'code_execution_20260120',
    },
    google: { web_search: true, web_fetch: true, code_execution: true },
    openrouter: { web_search: true, web_fetch: true, code_execution: null },
};

const WIRE_KEY: Record<ToolName, 'webSearch' | 'webFetch' | 'codeExecution'> = {
    web_search: 'webSearch',
    web_fetch: 'webFetch',
    code_execution: 'codeExecution',
};

// *** SHA-256 of the exact UTF-8 bytes of 'CourierAI' (no trailing newline),
// precomputed via python hashlib. The code_execution test asks the model for
// this digest: it can't produce a SHA-256 from memory, so a matching digest in
// the output proves the sandbox actually ran AND our tool-call/result mapping
// surfaced it. To regenerate:
//   python -c "import hashlib; print(hashlib.sha256('CourierAI'.encode()).hexdigest())"
const COURIERAI_SHA256 =
    '59d1aef073ffe17cb27ad0bae25c9b75bb7a94b6aa98944563bbf45efd4dc8a8';

const DEFAULT_PROMPTS: Record<ToolName, string> = {
    web_search:
        'Search the web for a news article published this week and briefly tell me what it says.',
    web_fetch:
        'Fetch https://www.formula1.com/en/racing/2026 and tell me when the next race is.',
    code_execution:
        "Use the code execution tool to compute the SHA-256 hex digest of the exact string 'CourierAI' (no quotes, no trailing newline) using Python's hashlib. Do not compute it from memory. Print only the digest.",
};

function flag(name: string): string | undefined {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

function thinkingDefaults(
    provider: ProviderName,
    modelId: string
): { level: ThinkingLevel; adaptive: boolean } {
    if (provider === 'openrouter') return { level: 'medium', adaptive: false };
    const thinking = PROVIDERS.find((p) => p.id === provider)?.models.find(
        (m) => m.id === modelId
    )?.params.thinking;
    return {
        level: thinking?.defaultLevel ?? 'none',
        adaptive: thinking?.adaptive !== undefined,
    };
}

function toolWire(
    provider: ProviderName,
    modelId: string,
    tool: ToolName
): string | boolean | null {
    const model = PROVIDERS.find((p) => p.id === provider)?.models.find(
        (m) => m.id === modelId
    );
    if (model) return model.tools?.[WIRE_KEY[tool]] ?? null;
    return TOOL_WIRE[provider][tool];
}

async function loadProvider(p: ProviderName): Promise<ProviderStream> {
    switch (p) {
        case 'openai':
            return (await import('../packages/courierai_ext/providers/openai'))
                .streamOpenAI;
        case 'anthropic':
            return (
                await import('../packages/courierai_ext/providers/anthropic')
            ).streamAnthropic;
        case 'google':
            return (await import('../packages/courierai_ext/providers/google'))
                .streamGoogle;
        case 'openrouter':
            return (
                await import('../packages/courierai_ext/providers/openrouter')
            ).streamOpenRouter;
    }
}

interface TurnResult {
    text: string;
    reasoningChars: number;
    sources: CourierAISourceUrlPart[];
    docs: number;
    files: number;
    toolEvents: string[];
    codeExecutions: CodeExecPart[];
    tokens?: { input: number; output: number };
}

function dumpChunk(chunk: CourierAIChunk): void {
    if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
        console.log(
            `  ${chunk.type} ${JSON.stringify(chunk.delta.slice(0, 80))}`
        );
    } else if (chunk.type === 'source-url') {
        console.log(`  source-url ${chunk.url}`);
    } else if (chunk.type === 'tool-call') {
        console.log(`  tool-call ${chunk.name} ${chunk.toolCallId}`);
    } else {
        console.log(`  ${chunk.type}`);
    }
}

async function runTurn(
    stream: ProviderStream,
    apiKey: string,
    model: string,
    messages: CourierAIMessage[],
    params: Record<string, unknown>,
    dump: boolean
): Promise<TurnResult> {
    const r: TurnResult = {
        text: '',
        reasoningChars: 0,
        sources: [],
        docs: 0,
        files: 0,
        toolEvents: [],
        codeExecutions: [],
    };
    for await (const chunk of stream({ apiKey, model, messages, params })) {
        if (dump) dumpChunk(chunk);
        switch (chunk.type) {
            case 'text-delta':
                r.text += chunk.delta;
                break;
            case 'reasoning-delta':
                r.reasoningChars += chunk.delta.length;
                break;
            case 'source-url':
                r.sources.push({
                    type: 'source-url',
                    sourceId: chunk.sourceId,
                    url: chunk.url,
                    ...(chunk.title ? { title: chunk.title } : {}),
                });
                break;
            case 'source-document':
                r.docs++;
                break;
            case 'file':
                r.files++;
                break;
            case 'tool-call':
                r.toolEvents.push(`call ${chunk.name} ${chunk.toolCallId}`);
                if (chunk.name === 'code_execution') {
                    r.codeExecutions.push({
                        type: 'tool',
                        toolCallId: chunk.toolCallId,
                        name: 'code_execution',
                        state: 'running',
                        ...(chunk.input ? { input: chunk.input } : {}),
                    });
                }
                break;
            case 'tool-result': {
                r.toolEvents.push(`result ${chunk.toolCallId}`);
                const ce = r.codeExecutions.find(
                    (p) => p.toolCallId === chunk.toolCallId
                );
                if (ce) {
                    ce.state = chunk.errorText ? 'error' : 'done';
                    if (chunk.errorText) ce.errorText = chunk.errorText;
                    if (chunk.output) ce.output = chunk.output;
                }
                break;
            }
            case 'finish':
                if (chunk.metadata?.tokens) r.tokens = chunk.metadata.tokens;
                break;
        }
    }
    return r;
}

function msg(
    role: 'user' | 'assistant',
    parts: CourierAIPart[]
): CourierAIMessage {
    return {
        id: crypto.randomUUID(),
        role,
        parts,
        metadata: { createdAt: Date.now() },
    };
}

function printHelp(): void {
    const providers = (
        Object.entries(PROVIDER_DEFAULTS) as [
            ProviderName,
            { env: string; model: string },
        ][]
    )
        .map(
            ([name, d]) =>
                `  ${name.padEnd(11)}${d.model.padEnd(22)} / ${d.env}`
        )
        .join('\n');
    console.log(`provider-test - isolation harness for the hand-rolled ext providers

Exercises one provider's SSE -> CourierAIChunk mapping for a chosen server
tool, without touching background.ts. It then runs the stateless replay
round-trip: turn 2 recalls a previously returned url (web_search / web_fetch)
or the prior code output (code_execution).

Usage:
  bun scripts/provider-test.ts --provider <name> [options]

Options:
  --provider <name>   openai | anthropic | google | openrouter   (required)
  --tool <name>       web_search | web_fetch | code_execution    (default: web_search)
  --model <id>        override the provider's default model
  --input, --prompt   override the default prompt for the tool
  --thinking <level>  thinking level         (default: the model's, none if unset)
  --adaptive <bool>   adaptive thinking      (default: the model's)
  --dump              print every CourierAIChunk as it streams
  -h, --help          show this help

Provider defaults (model / required env var):
${providers}

Examples:
  bun scripts/provider-test.ts --provider anthropic
  bun scripts/provider-test.ts --provider openai --tool web_fetch
  bun scripts/provider-test.ts --provider google --tool code_execution --dump`);
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
        printHelp();
        return;
    }

    const providerArg = flag('--provider');
    if (!providerArg) {
        printHelp();
        process.exit(1);
    }
    const provider = providerArg as ProviderName;
    const defaults = PROVIDER_DEFAULTS[provider];
    if (!defaults) throw new Error(`Unknown provider: ${provider}`);

    const tool = (flag('--tool') ?? 'web_search') as ToolName;
    if (!(tool in WIRE_KEY)) throw new Error(`Unknown tool: ${tool}`);

    const model = flag('--model') ?? defaults.model;
    const wireValue = toolWire(provider, model, tool);
    if (wireValue === null) {
        throw new Error(`${model} has no ${tool} server tool`);
    }
    const apiKey = process.env[defaults.env];
    if (!apiKey) throw new Error(`${defaults.env} missing from .env`);
    const dump = process.argv.includes('--dump');

    const stream = await loadProvider(provider);
    const input = flag('--input') ?? flag('--prompt') ?? DEFAULT_PROMPTS[tool];
    const defaultThinking = thinkingDefaults(provider, model);
    const adaptiveFlag = flag('--adaptive');
    const params = {
        tools: { [WIRE_KEY[tool]]: wireValue },
        thinkingLevel: flag('--thinking') ?? defaultThinking.level,
        adaptiveThinking:
            adaptiveFlag !== undefined
                ? adaptiveFlag === 'true'
                : defaultThinking.adaptive,
        maxTokens: 4096,
    };

    console.log(`=== ${provider} / ${model} · tool=${tool} ===`);
    console.log('--- TURN 1 ---');
    const t1 = await runTurn(
        stream,
        apiKey,
        model,
        [msg('user', [{ type: 'text', text: input, state: 'done' }])],
        params,
        dump
    );
    console.log('text:', JSON.stringify(t1.text.slice(0, 140)));
    console.log('reasoning chars:', t1.reasoningChars);
    console.log('toolEvents:', t1.toolEvents);
    console.log(
        'sources:',
        t1.sources.map((s) => s.url)
    );
    console.log('docs:', t1.docs, ' files:', t1.files);
    console.log('tokens:', t1.tokens);

    if (tool === 'web_fetch') {
        const requested = input
            .match(/https?:\/\/\S+/)?.[0]
            ?.replace(/[.,;]+$/, '');
        const fetched = requested
            ? t1.sources.find((s) => s.url.includes(requested))
            : t1.sources[0];
        if (!fetched) {
            console.error(
                `FAIL turn 1: requested page ${requested ?? '(none)'} not in sources ${JSON.stringify(t1.sources.map((s) => s.url))}`
            );
            process.exit(1);
        }

        console.log('\n--- TURN 2 (recall, sterile user + assistant text) ---');
        const assistantParts: CourierAIPart[] = [
            { type: 'text', text: 'I fetched the page.', state: 'done' },
            ...t1.sources,
        ];
        const t2 = await runTurn(
            stream,
            apiKey,
            model,
            [
                msg('user', [
                    {
                        type: 'text',
                        text: "Fetch a page and don't tell me anything about it.",
                        state: 'done',
                    },
                ]),
                msg('assistant', assistantParts),
                msg('user', [
                    {
                        type: 'text',
                        text: 'Great. Without fetching again, please print the previously returned URL verbatim.',
                        state: 'done',
                    },
                ]),
            ],
            params,
            dump
        );
        console.log('reply:', JSON.stringify(t2.text));
        console.log('tokens:', t2.tokens);

        const echoed = t1.sources.find((s) => t2.text.includes(s.url));
        const refetched = t2.toolEvents.some((e) => e.startsWith('call'));
        const ok = !!echoed && !refetched;
        const why =
            (echoed ? '' : ' (url not echoed verbatim)') +
            (refetched ? ' (re-fetched)' : '');
        console.log(
            `\nPASS: ${ok}`,
            ok ? `(matched ${echoed?.url})` : `(${why.trim()})`
        );
        process.exit(ok ? 0 : 1);
    }
    if (tool === 'code_execution') {
        const digestInTurn1 = t1.text.includes(COURIERAI_SHA256);
        if (!t1.codeExecutions.length || !digestInTurn1) {
            const why =
                (t1.codeExecutions.length
                    ? ''
                    : ' (no code_execution tool-call)') +
                (digestInTurn1
                    ? ''
                    : ` (digest ${COURIERAI_SHA256} not in turn-1 output)`);
            console.error(`FAIL turn 1:${why}`);
            process.exit(1);
        }

        console.log('\n--- TURN 2 (recall, sterile assistant text) ---');
        const assistantParts: CourierAIPart[] = [
            {
                type: 'text',
                text: 'I completed using the tool.',
                state: 'done',
            },
            ...t1.codeExecutions,
        ];
        const t2 = await runTurn(
            stream,
            apiKey,
            model,
            [
                msg('user', [{ type: 'text', text: input, state: 'done' }]),
                msg('assistant', assistantParts),
                msg('user', [
                    {
                        type: 'text',
                        text: 'Great! Without using the code execution tool again, print the output verbatim.',
                        state: 'done',
                    },
                ]),
            ],
            params,
            dump
        );
        console.log('reply:', JSON.stringify(t2.text));
        console.log('tokens:', t2.tokens);

        const echoed = t2.text.includes(COURIERAI_SHA256);
        const reran = t2.codeExecutions.length > 0;
        const ok = echoed && !reran;
        const why =
            (echoed ? '' : ' (digest not echoed)') +
            (reran ? ' (re-ran code exec)' : '');
        console.log(`\nPASS: ${ok}${ok ? '' : ` (${why.trim()})`}`);
        process.exit(ok ? 0 : 1);
    }

    if (!t1.sources.length) {
        console.error('FAIL: no source-url chunks captured');
        process.exit(1);
    }

    console.log('\n--- TURN 2 (recall, sterile assistant text) ---');
    const assistantParts: CourierAIPart[] = [
        { type: 'text', text: 'I completed the search.', state: 'done' },
        ...t1.sources,
    ];
    const t2 = await runTurn(
        stream,
        apiKey,
        model,
        [
            msg('user', [{ type: 'text', text: input, state: 'done' }]),
            msg('assistant', assistantParts),
            msg('user', [
                {
                    type: 'text',
                    text: 'Great. Without searching again, please print one of the previously returned URLs verbatim.',
                    state: 'done',
                },
            ]),
        ],
        params,
        dump
    );
    console.log('reply:', JSON.stringify(t2.text));
    console.log('tokens:', t2.tokens);

    const hit = t1.sources.find((s) => t2.text.includes(s.url));
    console.log(
        '\nPASS:',
        !!hit,
        hit ? `(matched ${hit.url})` : '(no verbatim match)'
    );
    process.exit(hit ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
