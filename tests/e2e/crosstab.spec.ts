import { CourierAI, expect, test } from './fixtures';

// cross-tab sync (broadcastBridge, appLifecycle). Two tabs share
// the one ephemeral profile + service worker; a turn sent in one fans out to
// the other without a manual reload.

test('a turn sent in one tab appears in another tab', async ({
    context,
    serviceWorker,
    courierai,
}) => {
    await courierai.goto();

    // Second tab on the same profile. Wait for it to finish init (provider
    // options only render once initialized, which is when the broadcast bridge
    // subscribes) before sending, so it can't miss the turn-start event.
    const page2 = await context.newPage();
    const second = new CourierAI(page2, serviceWorker);
    await second.goto();
    await expect(second.providerSelect().locator('option')).toHaveCount(4);

    await courierai.send('Say the word pineapple and nothing else.');

    // The turn fans out to the second tab's chat list immediately, but a remote
    // turn doesn't yank its active view - so open the synced chat (no reload).
    // Sidebar entry titles are the first 40 chars of the opening message.
    await second.page.getByRole('button', { name: /pineapple/i }).click();

    // The mirror tab now reflects both the user turn and the streamed assistant
    // reply that arrived over the broadcast, without a reload.
    await expect(second.userMessages().first()).toContainText('pineapple');
    await expect(second.assistantMessages().first()).toBeVisible();
    expect((await second.lastAssistantText()).length).toBeGreaterThan(0);

    // The turn persisted once to the shared ext IDB, closing the round trip
    // behind both tabs' DOM.
    await courierai.expectAssistantRoundTrip(/pineapple/i);
});
