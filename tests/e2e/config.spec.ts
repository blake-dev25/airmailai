import { expect, test } from './fixtures';

// config options. Spot-checked on the default cheap model.

test('Max Output Tokens cap truncates the response', async ({ courierai }) => {
    await courierai.goto();

    await courierai.setMaxTokens(5);
    await courierai.send('Write ten detailed paragraphs about the ocean.');

    const reply = await courierai.lastAssistantText();
    // A 5-token cap can't produce paragraphs - proves the cap reached the model
    // (and that the truncated output is surfaced, not silently dropped).
    expect(reply.length).toBeGreaterThan(0);
    expect(reply.length).toBeLessThan(200);
});

test('Temperature at min and max: readout updates and requests succeed', async ({
    courierai,
}) => {
    await courierai.goto();
    const badge = courierai.page.getByRole('spinbutton', {
        name: 'Temperature',
    });

    // Precise end.
    await courierai.setTemperature(0);
    await expect(badge).toHaveText('0.00');
    await courierai.send('Reply with exactly: ok');
    expect((await courierai.lastAssistantText()).length).toBeGreaterThan(0);
    await expect(courierai.appError()).toHaveCount(0);

    // Creative end - a value above the model's max clamps to the max readout
    // (Haiku 4.5 caps at 1).
    await courierai.setTemperature(2);
    await expect(badge).toHaveText('1.00');
    await courierai.send('Reply with exactly: ok');
    expect((await courierai.lastAssistantText()).length).toBeGreaterThan(0);
    await expect(courierai.appError()).toHaveCount(0);
});

test('System Prompt is obeyed and persists across turns', async ({
    courierai,
}) => {
    await courierai.goto();

    await courierai.setSystemPrompt(
        'Always reply with exactly one French word, lowercase, no punctuation.'
    );

    await courierai.send('What color is the sky?');
    await courierai.expectAssistantRoundTrip(/bleu/i);

    // Same chat, no re-statement - confirms the system prompt stuck.
    await courierai.send('What color is grass?');
    await courierai.expectAssistantRoundTrip(/vert/i);
});
