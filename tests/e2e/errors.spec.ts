import { expect, test } from './fixtures';

// errors must be LOUD, never silent.

test.describe('no API key seeded', () => {
    // Seed legal + settings but no keys, so the extension's pre-stream
    // "No API key saved" path fires. Zero API cost.
    test.use({ seedApiKeys: false });

    test('missing key surfaces a loud, dismissible error and persists no assistant', async ({
        courierai,
    }) => {
        await courierai.goto();
        await courierai.compose('hello');

        const error = courierai.appError();
        await expect(error).toBeVisible();
        await expect(error).toContainText(/no api key/i);

        // The user message persists, but no assistant row was written.
        const { messages } = await courierai.readDb();
        expect(
            messages.filter((m) => m.message.role === 'assistant')
        ).toHaveLength(0);

        // Dismissible.
        await courierai.page
            .getByRole('button', { name: 'Dismiss error' })
            .click();
        await expect(error).toBeHidden();
    });
});

test('OpenAI rejects sub-16 max tokens with a loud error', async ({
    courierai,
}) => {
    await courierai.goto();

    // Cheap, latest-tier model (avoid gpt-X-pro).
    await courierai.setProvider('OpenAI');
    await courierai.setModel('GPT-5.4 Mini');

    // OpenAI rejects responses capped under 16 tokens - the primary error-flow.
    await courierai.setMaxTokens(5);
    await courierai.compose('Write a short story about the ocean.');

    const error = courierai.appError();
    await expect(error).toBeVisible();
    await expect(error).toContainText(/error/i);
});
