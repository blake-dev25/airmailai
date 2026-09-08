import { expect, PROVIDER_MODELS, test } from './fixtures';

const anthropic = PROVIDER_MODELS.anthropic;
const openai = PROVIDER_MODELS.openai;

test('switching provider repopulates the model list', async ({ airmailai }) => {
    await airmailai.goto();

    await airmailai.setProvider(openai.label);
    await airmailai.modelTrigger().click();

    await expect(
        airmailai.page.locator(`[data-option-id="${openai.chat}"]`)
    ).toBeVisible();
    await expect(
        airmailai.page.locator(`[data-option-id="${anthropic.chat}"]`)
    ).toHaveCount(0);
});

test('switching model updates Model Details', async ({ airmailai }) => {
    expect(anthropic.contextWindow).not.toBe(openai.contextWindow);

    await airmailai.goto();
    await airmailai.setModelById(anthropic.chat);

    await expect(airmailai.modelTrigger()).toContainText(anthropic.chatName);
    await expect(airmailai.contextUsage()).toContainText(
        anthropic.contextWindow.toLocaleString('en-US')
    );

    await airmailai.setProvider(openai.label);
    await airmailai.setModelById(openai.chat);

    await expect(airmailai.modelTrigger()).toContainText(openai.chatName);
    await expect(airmailai.contextUsage()).toContainText(
        openai.contextWindow.toLocaleString('en-US')
    );
});

test('switching mid-conversation preserves history and uses the new model', async ({
    airmailai,
}) => {
    await airmailai.goto();

    await airmailai.send('My name is Banana. Remember it.');

    await airmailai.setProvider(openai.label);
    await airmailai.setModelById(openai.chat);
    await airmailai.send("What's my name? Reply with just the name.");

    await airmailai.expectAssistantRoundTrip('Banana');
    await expect(airmailai.userMessages()).toHaveCount(2);

    const { metas } = await airmailai.readDb();
    expect(metas).toHaveLength(1);
    expect(metas[0].modelId).toBe(openai.chat);
});
