import { expect, QUICK_TIMEOUT, test } from './fixtures';

test('app shell renders: sidebar, config panel, composer', async ({
    courierai,
}) => {
    await courierai.goto();
    await expect(
        courierai.page.getByRole('heading', { name: 'Configuration' })
    ).toBeVisible();
    await expect(courierai.newChatButton()).toBeVisible();
    await expect(
        courierai.page.getByText('Start a conversation')
    ).toBeVisible();
    await expect(courierai.composer()).toBeVisible();
});

test('single turn: streams, persists to ext IDB, auto-titles, updates token counter', async ({
    courierai,
}) => {
    await courierai.goto();

    await courierai.send('Reply with exactly: pong');

    // Round trip closed: the streamed reply is both in the DOM and persisted
    // to the ext IDB (normalized-equal, polled for the end-of-turn save).
    await courierai.expectAssistantRoundTrip();

    // Both roles persisted under the one chat.
    const { metas, messages } = await courierai.readDb();
    expect(metas).toHaveLength(1);
    const chatId = metas[0].id;
    const roles = messages
        .filter((m) => m.chatId === chatId)
        .map((m) => m.message.role);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');

    // Auto-titled away from the 'New Chat' default after the turn completes.
    await expect(async () => {
        const db = await courierai.readDb();
        expect(db.metas[0]?.title).not.toBe('New Chat');
    }).toPass({ timeout: QUICK_TIMEOUT });

    // Token/context counter now shows usage (the "x / y" form).
    await expect(courierai.contextUsage()).toContainText('/');
});
