import { expect, test } from './fixtures';

test('Max Output Tokens cap truncates the response', async ({ airmailai }) => {
    await airmailai.goto();

    await airmailai.setMaxTokens(5);
    await airmailai.send('Write ten detailed paragraphs about the ocean.');

    const reply = await airmailai.lastAssistantText();
    expect(reply.length).toBeGreaterThan(0);
    expect(reply.length).toBeLessThan(200);
});

test('Temperature at min and max: readout updates and requests succeed', async ({
    airmailai,
}) => {
    await airmailai.goto();
    const badge = airmailai.page.getByRole('spinbutton', {
        name: 'Temperature',
    });

    await airmailai.setTemperature(0);
    await expect(badge).toHaveText('0.00');
    await airmailai.send('Reply with exactly: ok');
    expect((await airmailai.lastAssistantText()).length).toBeGreaterThan(0);
    await expect(airmailai.appError()).toHaveCount(0);

    await airmailai.setTemperature(2);
    await expect(badge).toHaveText('1.00');
    await airmailai.send('Reply with exactly: ok');
    expect((await airmailai.lastAssistantText()).length).toBeGreaterThan(0);
    await expect(airmailai.appError()).toHaveCount(0);
});

test('System Prompt is obeyed and persists across turns', async ({
    airmailai,
}) => {
    await airmailai.goto();

    await airmailai.setSystemPrompt(
        'Always reply with exactly one French word, lowercase, no punctuation.'
    );

    await airmailai.send('What color is the sky?');
    await airmailai.expectAssistantRoundTrip(/bleu/i);

    await airmailai.send('What color is grass?');
    await airmailai.expectAssistantRoundTrip(/vert/i);
});
