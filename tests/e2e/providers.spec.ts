import { expect, PROVIDER_MODELS, type ProviderKey, test } from './fixtures';

const PROVIDERS: ProviderKey[] = [
    'anthropic',
    'openai',
    'google',
    'openrouter',
];

for (const key of PROVIDERS) {
    const { label, chat } = PROVIDER_MODELS[key];

    test(`${label} multiturn retains context and persists`, async ({
        courierai,
    }) => {
        await courierai.goto();
        await courierai.setProvider(label);
        if (key === 'openrouter') await courierai.waitForOpenRouterCatalog();
        await courierai.setModelById(chat);

        await courierai.send('My name is Banana. Remember it.');
        await courierai.send("What's my name? Reply with just the name.");

        await courierai.expectAssistantRoundTrip('Banana');
        await expect(courierai.userMessages()).toHaveCount(2);
        await expect(courierai.assistantMessages()).toHaveCount(2);

        await expect(courierai.sendButton()).toBeVisible();
        await expect(courierai.contextUsage()).toContainText('/');

        const { messages } = await courierai.readDb();
        expect(messages.filter((m) => m.message.role === 'user')).toHaveLength(
            2
        );
        expect(
            messages.filter((m) => m.message.role === 'assistant')
        ).toHaveLength(2);
    });
}
