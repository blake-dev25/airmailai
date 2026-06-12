import { expect, test } from './fixtures';

test('switching provider repopulates the model list', async ({ courierai }) => {
    await courierai.goto();

    await courierai.setProvider('OpenAI');
    await courierai.modelTrigger().click();

    await expect(
        courierai.page.locator('[data-model-id="gpt-5.4-mini"]')
    ).toBeVisible();
    await expect(
        courierai.page.locator('[data-model-id="claude-haiku-4-5"]')
    ).toHaveCount(0);
});

test('switching model updates Model Details', async ({ courierai }) => {
    await courierai.goto();

    await expect(courierai.contextUsage()).toContainText('200,000');
    await expect(courierai.page.getByText('Feb 2025')).toBeVisible();

    await courierai.setModelById('claude-opus-4-8');

    await expect(courierai.contextUsage()).toContainText('1,000,000');
    await expect(courierai.page.getByText('Jan 2026')).toBeVisible();
});

test('switching mid-conversation preserves history and uses the new model', async ({
    courierai,
}) => {
    await courierai.goto();

    await courierai.send('My name is Banana. Remember it.');

    await courierai.setProvider('OpenAI');
    await courierai.setModelById('gpt-5.4-mini');
    await courierai.send("What's my name? Reply with just the name.");

    await courierai.expectAssistantRoundTrip('Banana');
    await expect(courierai.userMessages()).toHaveCount(2);

    const { metas } = await courierai.readDb();
    expect(metas).toHaveLength(1);
    expect(metas[0].modelId).toBe('gpt-5.4-mini');
});
