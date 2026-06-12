import { CourierAI, expect, test } from './fixtures';

test('a turn sent in one tab appears in another tab', async ({
    context,
    serviceWorker,
    courierai,
}) => {
    await courierai.goto();

    const page2 = await context.newPage();
    const second = new CourierAI(page2, serviceWorker);
    await second.goto();
    await expect(second.providerSelect().locator('option')).toHaveCount(4);

    await courierai.send('Say the word pineapple and nothing else.');

    await second.page.getByRole('button', { name: /pineapple/i }).click();

    await expect(second.userMessages().first()).toContainText('pineapple');
    await expect(second.assistantMessages().first()).toBeVisible();
    expect((await second.lastAssistantText()).length).toBeGreaterThan(0);

    await courierai.expectAssistantRoundTrip(/pineapple/i);
});
