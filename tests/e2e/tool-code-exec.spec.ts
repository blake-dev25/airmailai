import {
    expect,
    PROVIDER_MODELS,
    type ProviderKey,
    test,
    TOOL_TURN_TIMEOUT,
} from './fixtures';

test.use({ seedCodeExecEnabled: true });

const AIRMAILAI_SHA256 =
    '59d1aef073ffe17cb27ad0bae25c9b75bb7a94b6aa98944563bbf45efd4dc8a8';

const PROVIDERS: ProviderKey[] = ['anthropic', 'openai', 'google'];

for (const key of PROVIDERS) {
    const { label, tools } = PROVIDER_MODELS[key];

    test(`${label} code execution runs Python and returns the digest`, async ({
        airmailai,
    }) => {
        test.setTimeout(180_000);
        await airmailai.goto();
        await airmailai.setProvider(label);
        await airmailai.setModelById(tools);
        await airmailai.setChatCodeExecution(true);

        await airmailai.send(
            "Use the code execution tool to compute the SHA-256 hex digest of the exact string 'AirmailAI' (no quotes, no trailing newline) using Python's hashlib. Do not compute it from memory. Print only the digest.",
            { turnTimeout: TOOL_TURN_TIMEOUT }
        );

        expect((await airmailai.lastAssistantText()).toLowerCase()).toContain(
            AIRMAILAI_SHA256
        );
        await expect
            .poll(async () => airmailai.persistedToolNames())
            .toContain('code_execution');

        await airmailai.expandCode();
    });
}
