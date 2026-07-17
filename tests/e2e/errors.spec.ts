import { expect, test } from './fixtures';

test.describe('no API key seeded', () => {
    test.use({ seedApiKeys: false });

    test('missing key surfaces a loud, dismissible error and persists no assistant', async ({
        airmailai,
    }) => {
        await airmailai.goto();
        await airmailai.compose('hello');

        const error = airmailai.appError();
        await expect(error).toBeVisible();
        await expect(error).toContainText(/no api key/i);

        const { messages } = await airmailai.readDb();
        expect(
            messages.filter((m) => m.message.role === 'assistant')
        ).toHaveLength(0);

        await airmailai.page
            .getByRole('button', { name: 'Dismiss error' })
            .click();
        await expect(error).toBeHidden();
    });
});

test('OpenAI rejects sub-16 max tokens with a loud error', async ({
    airmailai,
}) => {
    await airmailai.goto();

    await airmailai.setProvider('OpenAI');
    await airmailai.setModel('GPT-5.4 Mini');

    await airmailai.setMaxTokens(5);
    await airmailai.compose('Write a short story about the ocean.');

    const error = airmailai.appError();
    await expect(error).toBeVisible();
    await expect(error).toContainText(/error/i);
});
