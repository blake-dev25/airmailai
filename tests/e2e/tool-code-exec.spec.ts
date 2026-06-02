import {
    expect,
    PROVIDER_MODELS,
    type ProviderKey,
    test,
    TOOL_TURN_TIMEOUT,
} from './fixtures';

// Code Execution. One turn per provider: the model runs Python in the sandbox to
// hash a string it can't hash from memory, so a matching digest in the reply
// proves the sandbox truly ran AND our tool-call/result mapping surfaced it
// (mirrors provider-test.ts, which PASSes code_execution on fired + digestOk).
//
// OpenRouter has no code_execution server tool (its catalog exposes only web
// search + fetch - see models/openrouter.ts), so it's excluded here, matching
// provider-test.ts's TOOL_WIRE.
//
// Seed only the Code Execution master toggle so ModelConfig renders the
// per-model Code Execution control.
test.use({ seedCodeExecEnabled: true });

// SHA-256 of the exact UTF-8 bytes of 'CourierAI' (no trailing newline). The
// model can't produce this from memory, so a match is proof the sandbox ran.
// Mirrors COURIERAI_SHA256 in provider-test.ts. To regenerate:
//   python -c "import hashlib; print(hashlib.sha256('CourierAI'.encode()).hexdigest())"
const COURIERAI_SHA256 =
    '59d1aef073ffe17cb27ad0bae25c9b75bb7a94b6aa98944563bbf45efd4dc8a8';

const PROVIDERS: ProviderKey[] = ['anthropic', 'openai', 'google'];

for (const key of PROVIDERS) {
    const { label, tools } = PROVIDER_MODELS[key];

    test(`${label} code execution runs Python and returns the digest`, async ({
        courierai,
    }) => {
        // A code-exec turn makes an extra provider round trip (up to
        // TOOL_TURN_TIMEOUT), so it needs headroom past the default 60s per-test
        // cap and the 120s tool-turn ceiling.
        test.setTimeout(180_000);
        await courierai.goto();
        await courierai.setProvider(label);
        await courierai.setModelById(tools);
        await courierai.setChatCodeExecution(true);

        // Same prompt as provider-test.ts DEFAULT_PROMPTS.code_execution.
        await courierai.send(
            "Use the code execution tool to compute the SHA-256 hex digest of the exact string 'CourierAI' (no quotes, no trailing newline) using Python's hashlib. Do not compute it from memory. Print only the digest.",
            { turnTimeout: TOOL_TURN_TIMEOUT }
        );

        // PASS = the precomputed digest appears in the reply (only possible if
        // the sandbox actually ran the hash)...
        expect((await courierai.lastAssistantText()).toLowerCase()).toContain(
            COURIERAI_SHA256
        );
        // ...and the code_execution tool part persisted - the IDB truth that the
        // server tool fired. Polled: the ext writes the row at end-of-turn.
        await expect
            .poll(async () => courierai.persistedToolNames())
            .toContain('code_execution');

        // Expand the Code expando so --ui / trace snapshots capture the rendered
        // code body and its output.
        await courierai.expandCode();
    });
}
