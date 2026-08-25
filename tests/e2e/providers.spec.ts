import { expect, PROVIDER_MODELS, type ProviderKey, test } from './fixtures';

const PROVIDERS: ProviderKey[] = [
    'anthropic',
    'openai',
    'google',
    'openrouter',
];

for (const key of PROVIDERS) {
    const { label, chat, chatName } = PROVIDER_MODELS[key];

    test(`${label} multiturn retains context and persists`, async ({
        airmailai,
    }) => {
        await airmailai.goto();
        await airmailai.setProvider(label);
        if (key === 'openrouter') {
            await airmailai.waitForOpenRouterCatalog();
            await airmailai.setModelById(chat);
        }
        await expect(airmailai.modelTrigger()).toContainText(chatName);

        await airmailai.send('My name is Banana. Remember it.');
        await airmailai.send("What's my name? Reply with just the name.");

        await airmailai.expectAssistantRoundTrip('Banana');
        await expect(airmailai.userMessages()).toHaveCount(2);
        await expect(airmailai.assistantMessages()).toHaveCount(2);

        await expect(airmailai.sendButton()).toBeVisible();
        await expect(airmailai.contextUsage()).toContainText('/');

        const { messages } = await airmailai.readDb();
        expect(messages.filter((m) => m.message.role === 'user')).toHaveLength(
            2
        );
        expect(
            messages.filter((m) => m.message.role === 'assistant')
        ).toHaveLength(2);
    });
}
