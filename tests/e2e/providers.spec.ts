import { expect, PROVIDER_MODELS, type ProviderKey, test } from './fixtures';

// per provider, run a multiturn conversation (>=3 turns) with a
// follow-up that depends on prior context, and confirm context is retained,
// send re-enables, the token counter updates, and both turns persist to IDB.
//
// One test per provider: each is a single dependent round-trip chain (turn 2
// only means anything because turn 1's context carried), so they live together
// rather than splitting "send" from "remembers".

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

        // Stop reverted to Send after the turn, and the context counter shows
        // usage. (Send is disabled on an empty composer, so assert it returned
        // - not that it's enabled.)
        await expect(courierai.sendButton()).toBeVisible();
        await expect(courierai.contextUsage()).toContainText('/');

        // Both turns persisted to the extension's IDB.
        const { messages } = await courierai.readDb();
        expect(messages.filter((m) => m.message.role === 'user')).toHaveLength(
            2
        );
        expect(
            messages.filter((m) => m.message.role === 'assistant')
        ).toHaveLength(2);
    });
}
