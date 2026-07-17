import { expect, QUICK_TIMEOUT, test } from './fixtures';

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

test('key test marks a saved working key as Valid', async ({ courierai }) => {
    await courierai.goto();
    await courierai.openSettings();

    const row = courierai
        .settingsDialog()
        .locator('tr')
        .filter({ hasText: 'Anthropic' });
    await row.getByRole('button', { name: 'Test', exact: true }).click();

    await expect(row.getByRole('button', { name: 'Valid' })).toBeVisible({
        timeout: QUICK_TIMEOUT,
    });
});

test('key test marks a bogus key as Invalid with a loud error', async ({
    courierai,
}) => {
    await courierai.goto();
    await courierai.openSettings();

    const dialog = courierai.settingsDialog();
    const row = dialog.locator('tr').filter({ hasText: 'OpenRouter' });
    await row.getByPlaceholder('Paste key...').fill('sk-or-v1-bogus');
    await row.getByRole('button', { name: 'Save', exact: true }).click();
    await row.getByRole('button', { name: 'Test', exact: true }).click();

    await expect(row.getByRole('button', { name: 'Invalid' })).toBeVisible({
        timeout: QUICK_TIMEOUT,
    });
    await expect(dialog.getByRole('alert')).toContainText('OpenRouter');
});
