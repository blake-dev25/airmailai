import { expect, test } from './fixtures';

test('Settings popover opens, shows storage, and persists across reopen', async ({
    courierai,
}) => {
    await courierai.goto();

    await courierai.openSettings();

    await courierai.settingsTab('Local Storage').click();
    const dialog = courierai.settingsDialog();
    await expect(dialog.getByText('Device Settings & API Keys')).toBeVisible();
    await expect(
        dialog.getByText('Chat History', { exact: true })
    ).toBeVisible();
    await expect(
        dialog.getByText(/\d+(\.\d+)?\s(B|KB|MB|GB)/).first()
    ).toBeVisible();

    await courierai.closeSettings();
    await courierai.openSettings();
    await expect(dialog.locator('.icon-check')).toHaveCount(4);
});

test('clearing an API key removes it and persists across reopen', async ({
    courierai,
}) => {
    await courierai.goto();
    await courierai.openSettings();

    const dialog = courierai.settingsDialog();
    await expect(dialog.locator('.icon-check')).toHaveCount(4);

    const orRow = dialog.locator('tr').filter({ hasText: 'OpenRouter' });
    await orRow.getByRole('button', { name: 'Clear', exact: true }).click();

    await expect(orRow.locator('.icon-x')).toBeVisible();
    await expect(dialog.locator('.icon-check')).toHaveCount(3);

    await courierai.closeSettings();
    await courierai.openSettings();
    await expect(dialog.locator('.icon-check')).toHaveCount(3);
});
