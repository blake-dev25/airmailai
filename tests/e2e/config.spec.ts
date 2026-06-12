import { expect, test } from './fixtures';

test('Max Output Tokens cap truncates the response', async ({ courierai }) => {
    await courierai.goto();

    await courierai.setMaxTokens(5);
    await courierai.send('Write ten detailed paragraphs about the ocean.');

    const reply = await courierai.lastAssistantText();
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

    await courierai.setTemperature(0);
    await expect(badge).toHaveText('0.00');
    await courierai.send('Reply with exactly: ok');
    expect((await courierai.lastAssistantText()).length).toBeGreaterThan(0);
    await expect(courierai.appError()).toHaveCount(0);

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

    await courierai.send('What color is grass?');
    await courierai.expectAssistantRoundTrip(/vert/i);
});
