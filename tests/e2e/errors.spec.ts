import { expect, test } from './fixtures';

test.describe('no API key seeded', () => {
    test.use({ seedApiKeys: false });

    test('missing key surfaces a loud, dismissible error and persists no assistant', async ({
        courierai,
    }) => {
        await courierai.goto();
        await courierai.compose('hello');

        const error = courierai.appError();
        await expect(error).toBeVisible();
        await expect(error).toContainText(/no api key/i);

        const { messages } = await courierai.readDb();
        expect(
            messages.filter((m) => m.message.role === 'assistant')
        ).toHaveLength(0);

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

    await courierai.setProvider('OpenAI');
    await courierai.setModel('GPT-5.4 Mini');

    await courierai.setMaxTokens(5);
    await courierai.compose('Write a short story about the ocean.');

    const error = courierai.appError();
    await expect(error).toBeVisible();
    await expect(error).toContainText(/error/i);
});
