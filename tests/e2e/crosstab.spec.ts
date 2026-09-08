import { AirmailAI, expect, test } from './fixtures';

test('a turn sent in one tab appears in another tab', async ({
    context,
    serviceWorker,
    airmailai,
}) => {
    await airmailai.goto();

    const page2 = await context.newPage();
    const second = new AirmailAI(page2, serviceWorker);
    await second.goto();
    await second.providerSelect().click();
    await expect(second.page.getByRole('option')).toHaveCount(4);
    await second.page.getByRole('listbox').press('Escape');

    await airmailai.send('Say the word pineapple and nothing else.');

    await second.page.getByRole('button', { name: /pineapple/i }).click();

    await expect(second.userMessages().first()).toContainText('pineapple');
    await expect(second.assistantMessages().first()).toBeVisible();
    expect((await second.lastAssistantText()).length).toBeGreaterThan(0);

    await airmailai.expectAssistantRoundTrip(/pineapple/i);
});
