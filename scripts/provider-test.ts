// Isolation harness for the hand-rolled providers. Exercises a provider's
// SSE -> CourierAIChunk mapping for a chosen server tool (web_search /
// web_fetch / code_execution), and for web_search also the stateless replay
// round-trip (OpenAI/Google/OpenRouter text-fold; Anthropic native) - all
// without touching background.ts.
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
    ProviderStream,
} from '@courierai/shared';
import {
    PROVIDERS,
    type ThinkingLevel,
} from '../packages/courierai_web/src/lib/models';

type ProviderName = 'openai' | 'anthropic' | 'google' | 'openrouter';
type ToolName = 'web_search' | 'web_fetch' | 'code_execution';

const PROVIDER_DEFAULTS: Record<ProviderName, { env: string; model: string }> =
    {
        openai: { env: 'OPENAI_API_KEY', model: 'gpt-5.5' },
        anthropic: { env: 'ANTHROPIC_API_KEY', model: 'claude-haiku-4-5' },
        google: { env: 'GOOGLE_API_KEY', model: 'gemini-3.5-flash' },
        openrouter: { env: 'OPENROUTER_API_KEY', model: 'openai/gpt-5.5' },
    };

// The value the website would send as params.tools[wireKey]: a versioned tool
// TYPE string for Anthropic (the website owns the version map), a bool for the
// rest. null = that provider has no such server tool.
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

// Tool name -> the camelCase key the providers read off params.tools.
const WIRE_KEY: Record<ToolName, 'webSearch' | 'webFetch' | 'codeExecution'> = {
    web_search: 'webSearch',
    web_fetch: 'webFetch',
    code_execution: 'codeExecution',
};

// SHA-256 of the exact UTF-8 bytes of 'CourierAI' (no trailing newline),
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

// Mirror the website (ModelConfig.svelte): a model's thinking defaults come
// from its declared params.thinking. Models without it (e.g. claude-haiku-4-5)
// support no effort/thinking - forcing one makes the provider enable thinking,
// which the API rejects. OpenRouter's catalog is hydrated at runtime so its
// models aren't in PROVIDERS here; default it to 'medium' (pass --thinking none
// to test a non-reasoning OpenRouter model).
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

// Send the exact tool support the chosen model declares. Anthropic pins a dated
// tool TYPE per model (haiku -> code_execution_20250825, not the latest
// _20260120), so a flat per-provider map would hand haiku a version it can't
// use. Unknown models (OpenRouter's runtime catalog) fall back to TOOL_WIRE.
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
                // Preserve providerMetadata - Anthropic needs it to replay.
                r.sources.push({
                    type: 'source-url',
                    sourceId: chunk.sourceId,
                    url: chunk.url,
                    ...(chunk.title ? { title: chunk.title } : {}),
                    ...(chunk.providerMetadata
                        ? { providerMetadata: chunk.providerMetadata }
                        : {}),
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
                break;
            case 'tool-result':
                r.toolEvents.push(`result ${chunk.toolCallId}`);
                break;
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
tool, without touching background.ts. For web_search it also runs the
stateless replay round-trip (turn 2 recalls a previously returned url).

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
    // Thinking/adaptive default to what this model declares (none for models
    // like haiku that have no thinking config); --thinking / --adaptive override.
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
    console.log(
        'source meta keys:',
        t1.sources.map((s) =>
            s.providerMetadata ? Object.keys(s.providerMetadata) : []
        )
    );
    console.log('docs:', t1.docs, ' files:', t1.files);
    console.log('tokens:', t1.tokens);

    // web_fetch and code_execution have no stateless-replay round-trip, so each
    // has its own PASS gate (web_search's round-trip check continues below).
    if (tool === 'web_fetch') {
        // Proof the page was actually fetched: it surfaces as a source. Providers
        // differ on tool-call wiring (Anthropic emits a web_fetch tool part;
        // OpenAI folds fetch into web_search; Google/OpenRouter emit neither), so
        // the source-url is the portable signal - matching the e2e spec. If the
        // prompt names a URL (the default does), require that exact page.
        const requested = input
            .match(/https?:\/\/\S+/)?.[0]
            ?.replace(/[.,;]+$/, '');
        const hit = requested
            ? t1.sources.find((s) => s.url.includes(requested))
            : t1.sources[0];
        const detail = hit
            ? ` (source ${hit.url})`
            : ' (fetched page not in sources)';
        console.log(`\nPASS: ${!!hit}${detail}`);
        process.exit(hit ? 0 : 1);
    }
    if (tool === 'code_execution') {
        // PASS = the tool fired AND the precomputed digest is in the output -
        // proof the sandbox truly ran (the model can't produce a SHA-256 from
        // memory) and our tool-call/result mapping surfaced it.
        const fired = t1.toolEvents.length > 0;
        const digestOk = t1.text.includes(COURIERAI_SHA256);
        const ok = fired && digestOk;
        const why =
            (fired ? '' : ' (no tool-call emitted)') +
            (digestOk
                ? ''
                : ` (expected digest ${COURIERAI_SHA256} not in output)`);
        console.log(`\nPASS: ${ok}${ok ? '' : why}`);
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
