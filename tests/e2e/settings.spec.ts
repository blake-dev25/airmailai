import { expect, test } from './fixtures';

// Settings UI (SettingsPopover). No API cost.

test('Settings popover opens, shows storage, and persists across reopen', async ({
    courierai,
}) => {
    await courierai.goto();

    await courierai.openSettings();

    // Storage section renders and reflects current state. The seeded profile
    // has sync settings, so at least one row shows a real byte figure.
    await courierai.settingsTab('Storage').click();
    const dialog = courierai.settingsDialog();
    await expect(dialog.getByText('Local Settings')).toBeVisible();
    // exact:true so it matches only the storage-row label, not the
    // "Delete chat history" button (substring match would hit both).
    await expect(
        dialog.getByText('Chat History', { exact: true })
    ).toBeVisible();
    await expect(
        dialog.getByText(/\d+(\.\d+)?\s(B|KB|MB|GB)/).first()
    ).toBeVisible();

    // Close and reopen: the seeded keys still read as saved (4 providers, 4
    // check marks) - the popover reflects persisted state on every open.
    await courierai.closeSettings();
    await courierai.openSettings();
    await expect(dialog.locator('.icon-check')).toHaveCount(4);
});

test('clearing an API key removes it and persists across reopen', async ({
    courierai,
}) => {
    await courierai.goto();
    await courierai.openSettings();

    // API Keys is the default tab; the seeded profile has 4 provider keys, so
    // 4 check marks.
    const dialog = courierai.settingsDialog();
    await expect(dialog.locator('.icon-check')).toHaveCount(4);

    // Clear the OpenRouter key. Scope the Clear button to that provider's row
    // (filter by row text, not accessible name) so the other rows' buttons
    // aren't clicked. Clearing a key has no confirm dialog.
    const orRow = dialog.locator('tr').filter({ hasText: 'OpenRouter' });
    await orRow.getByRole('button', { name: 'Clear', exact: true }).click();

    // That row flips to the unsaved (x) state; one fewer check mark overall.
    await expect(orRow.locator('.icon-x')).toBeVisible();
    await expect(dialog.locator('.icon-check')).toHaveCount(3);

    // Persisted: reopen and the cleared key still reads as unsaved - the popover
    // re-reads saved state from the ext (checkApiKeys) on every open.
    await courierai.closeSettings();
    await courierai.openSettings();
    await expect(dialog.locator('.icon-check')).toHaveCount(3);
});
