import { expect, test } from './fixtures';

// streaming controls. One combined flow: the "send after stop"
// and "partial was persisted" checks both depend on having stopped a stream
// mid-flight, so they ride a single chain with test.step() labels.

test('Stop halts mid-stream, keeps partial, and persists the chopped answer', async ({
    courierai,
}) => {
    await courierai.goto();
    // Use a smarter model than the seeded default (haiku) so the follow-up turn
    // reliably echoes the chopped answer's last three words verbatim. Thinking
    // off, or the 2s-then-stop below could catch only a thinking block (the
    // visible-text assertions need text, not reasoning).
    await courierai.setModelById('claude-sonnet-4-6');
    await courierai.setThinkingNone();

    let partial = '';

    await test.step('stop mid-stream keeps partial and reverts the button', async () => {
        await courierai.compose(
            'Write twelve detailed paragraphs about the history of sailing ships.'
        );
        await expect(courierai.stopButton()).toBeVisible();
        // Let a couple seconds of text accumulate (NOT 10), then cut it off.
        await courierai.page.waitForTimeout(2000);
        await courierai.stopButton().click();

        await expect(courierai.stopButton()).toBeHidden();
        await expect(courierai.sendButton()).toBeVisible();

        partial = await courierai.lastAssistantText();
        expect(partial.length).toBeGreaterThan(0);
        await expect(courierai.assistantMessages()).toHaveCount(1);
    });

    await test.step('the chopped partial was persisted to the ext IDB', async () => {
        // Direct IDB check (the echo step below proves re-injection too): the
        // ext wrote the chopped partial - not nothing, not the full answer.
        // Only one assistant row exists at this point. Poll for the
        // end-of-turn save, then tie content via the opening words - the DOM
        // and IDB partials share a stream head, so the first words match even
        // if the cut-off tail races by a token.
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
        // Words the response was cut off on. If the chopped (not full/empty)
        // answer was stored and re-injected, the model can echo these. Assert
        // all three appear (order/punctuation-tolerant) to prove persistence
        // without depending on the model's exact phrasing.
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
