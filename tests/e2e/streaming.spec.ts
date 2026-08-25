import { expect, PROVIDER_MODELS, test } from './fixtures';

test('Stop halts mid-stream, keeps partial, and persists the chopped answer', async ({
    airmailai,
}) => {
    await airmailai.goto();
    await expect(airmailai.modelTrigger()).toContainText(
        PROVIDER_MODELS.anthropic.chatName
    );
    await airmailai.setThinkingNone();

    let partial = '';

    await test.step('stop mid-stream keeps partial and reverts the button', async () => {
        await airmailai.compose(
            'Write twelve detailed paragraphs about the history of sailing ships.'
        );
        await expect(airmailai.stopButton()).toBeVisible();
        await airmailai.page.waitForTimeout(2000);
        await airmailai.stopButton().click();

        await expect(airmailai.stopButton()).toBeHidden();
        await expect(airmailai.sendButton()).toBeVisible();

        partial = await airmailai.lastAssistantText();
        expect(partial.length).toBeGreaterThan(0);
        await expect(airmailai.assistantMessages()).toHaveCount(1);
    });

    await test.step('the chopped partial was persisted to the ext IDB', async () => {
        const opening = partial.trim().split(/\s+/).slice(0, 3).join(' ');
        await expect
            .poll(
                async () =>
                    (await airmailai.persistedTexts('assistant')).at(-1) ?? ''
            )
            .toContain(opening);
    });

    await test.step('a follow-up turn works normally after stopping', async () => {
        await airmailai.send(
            'Repeat the last three words of your previous message, verbatim.'
        );
        await expect(airmailai.assistantMessages()).toHaveCount(2);
    });

    await test.step('the chopped answer was persisted (echoed back)', async () => {
        const words = partial
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .trim()
            .split(/\s+/);
        expect(words.length).toBeGreaterThanOrEqual(3);
        const last3 = words.slice(-3).map((w) => w.toLowerCase());

        const echo = (await airmailai.lastAssistantText()).toLowerCase();
        for (const word of last3) expect(echo).toContain(word);
    });
});
