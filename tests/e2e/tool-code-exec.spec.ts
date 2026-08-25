import {
    expect,
    PROVIDER_MODELS,
    type ProviderKey,
    test,
    TOOL_TURN_TIMEOUT,
} from './fixtures';

test.use({ seedCodeExecEnabled: true });

const AIRMAILAI_SHA256 =
    'af0ee59d2a627d4e3aac6123be7cb87e9e79c7df311fd7b46ef2c3255f1f0ab4';

const PROVIDERS: ProviderKey[] = ['anthropic', 'openai', 'google'];

for (const key of PROVIDERS) {
    const { label, toolsName } = PROVIDER_MODELS[key];

    test(`${label} code execution runs Python and returns the digest`, async ({
        airmailai,
    }) => {
        test.setTimeout(180_000);
        await airmailai.goto();
        await airmailai.setProvider(label);
        await expect(airmailai.modelTrigger()).toContainText(toolsName);
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
