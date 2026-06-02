import { expect, test } from './fixtures';

// model / provider switching.

// No-API: switching provider repopulates the ModelPicker for that provider.
test('switching provider repopulates the model list', async ({ courierai }) => {
    await courierai.goto();

    await courierai.setProvider('OpenAI');
    await courierai.modelTrigger().click();

    // An OpenAI model is now offered and the previous provider's models aren't.
    await expect(
        courierai.page.locator('[data-model-id="gpt-5.4-mini"]')
    ).toBeVisible();
    await expect(
        courierai.page.locator('[data-model-id="claude-haiku-4-5"]')
    ).toHaveCount(0);
});

// No-API: switching model updates Model Details (context window, cutoff).
test('switching model updates Model Details', async ({ courierai }) => {
    await courierai.goto();

    // Default is Haiku 4.5: 200K context, Feb 2025 cutoff.
    await expect(courierai.contextUsage()).toContainText('200,000');
    await expect(courierai.page.getByText('Feb 2025')).toBeVisible();

    await courierai.setModelById('claude-opus-4-8');

    // Opus 4.8: 1M context, Jan 2026 cutoff.
    await expect(courierai.contextUsage()).toContainText('1,000,000');
    await expect(courierai.page.getByText('Jan 2026')).toBeVisible();
});

// API: switch provider+model mid-conversation; the new model answers and prior
// history is preserved.
test('switching mid-conversation preserves history and uses the new model', async ({
    courierai,
}) => {
    await courierai.goto();

    await courierai.send('My name is Banana. Remember it.');

    await courierai.setProvider('OpenAI');
    await courierai.setModelById('gpt-5.4-mini');
    await courierai.send("What's my name? Reply with just the name.");

    // History carried across the switch - the new model's reply is in the DOM
    // and persisted to the ext IDB.
    await courierai.expectAssistantRoundTrip('Banana');
    await expect(courierai.userMessages()).toHaveCount(2);

    // The chat's persisted config now reflects the model we switched to,
    // proving the second turn ran on it.
    const { metas } = await courierai.readDb();
    expect(metas).toHaveLength(1);
    expect(metas[0].modelId).toBe('gpt-5.4-mini');
});
