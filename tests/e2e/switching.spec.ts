import { expect, test } from './fixtures';

test.use({ seedModelTier: 'legacy' });

test('switching provider repopulates the model list', async ({ airmailai }) => {
    await airmailai.goto();

    await airmailai.setProvider('OpenAI');
    await airmailai.modelTrigger().click();

    await expect(
        airmailai.page.locator('[data-model-id="gpt-5.4-mini"]')
    ).toBeVisible();
    await expect(
        airmailai.page.locator('[data-model-id="claude-haiku-4-5"]')
    ).toHaveCount(0);
});

test('switching model updates Model Details', async ({ airmailai }) => {
    await airmailai.goto();
    await airmailai.setModelById('claude-haiku-4-5');

    await expect(airmailai.contextUsage()).toContainText('200,000');
    await expect(airmailai.page.getByText('Feb 2025')).toBeVisible();

    await airmailai.setModelById('claude-opus-4-8');

    await expect(airmailai.contextUsage()).toContainText('1,000,000');
    await expect(airmailai.page.getByText('Jan 2026')).toBeVisible();
});

test('switching mid-conversation preserves history and uses the new model', async ({
    airmailai,
}) => {
    await airmailai.goto();

    await airmailai.send('My name is Banana. Remember it.');

    await airmailai.setProvider('OpenAI');
    await airmailai.setModelById('gpt-5.4-mini');
    await airmailai.send("What's my name? Reply with just the name.");

    await airmailai.expectAssistantRoundTrip('Banana');
    await expect(airmailai.userMessages()).toHaveCount(2);

    const { metas } = await airmailai.readDb();
    expect(metas).toHaveLength(1);
    expect(metas[0].modelId).toBe('gpt-5.4-mini');
});
