import { expect, QUICK_TIMEOUT, test } from './fixtures';

test('app shell renders: sidebar, config panel, composer', async ({
    airmailai,
}) => {
    await airmailai.goto();
    await expect(
        airmailai.page.getByRole('heading', { name: 'Configuration' })
    ).toBeVisible();
    await expect(airmailai.newChatButton()).toBeVisible();
    await expect(
        airmailai.page.getByText('Start a conversation')
    ).toBeVisible();
    await expect(airmailai.composer()).toBeVisible();
});

test('single turn: streams, persists to ext IDB, auto-titles, updates token counter', async ({
    airmailai,
}) => {
    await airmailai.goto();

    await airmailai.send('Reply with exactly: pong');

    await airmailai.expectAssistantRoundTrip();

    const { metas, messages } = await airmailai.readDb();
    expect(metas).toHaveLength(1);
    const chatId = metas[0].id;
    const roles = messages
        .filter((m) => m.chatId === chatId)
        .map((m) => m.message.role);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');

    await expect(async () => {
        const db = await airmailai.readDb();
        expect(db.metas[0]?.title).not.toBe('New Chat');
    }).toPass({ timeout: QUICK_TIMEOUT });

    await expect(airmailai.contextUsage()).toContainText('/');
});
