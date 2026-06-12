import { expect, test } from './fixtures';

test('Stop halts mid-stream, keeps partial, and persists the chopped answer', async ({
    courierai,
}) => {
    await courierai.goto();
    await courierai.setModelById('claude-sonnet-4-6');
    await courierai.setThinkingNone();

    let partial = '';

    await test.step('stop mid-stream keeps partial and reverts the button', async () => {
        await courierai.compose(
            'Write twelve detailed paragraphs about the history of sailing ships.'
        );
        await expect(courierai.stopButton()).toBeVisible();
        await courierai.page.waitForTimeout(2000);
        await courierai.stopButton().click();

        await expect(courierai.stopButton()).toBeHidden();
        await expect(courierai.sendButton()).toBeVisible();

        partial = await courierai.lastAssistantText();
        expect(partial.length).toBeGreaterThan(0);
        await expect(courierai.assistantMessages()).toHaveCount(1);
    });

    await test.step('the chopped partial was persisted to the ext IDB', async () => {
        const opening = partial.trim().split(/\s+/).slice(0, 3).join(' ');
        await expect
            .poll(
                async () =>
                    (await courierai.persistedTexts('assistant')).at(-1) ?? ''
            )
            .toContain(opening);
    });

    await test.step('a follow-up turn works normally after stopping', async () => {
        await courierai.send(
            'Repeat the last three words of your previous message, verbatim.'
        );
        await expect(courierai.assistantMessages()).toHaveCount(2);
    });

    await test.step('the chopped answer was persisted (echoed back)', async () => {
        const words = partial
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .trim()
            .split(/\s+/);
        expect(words.length).toBeGreaterThanOrEqual(3);
        const last3 = words.slice(-3).map((w) => w.toLowerCase());

        const echo = (await courierai.lastAssistantText()).toLowerCase();
        for (const word of last3) expect(echo).toContain(word);
    });
});
