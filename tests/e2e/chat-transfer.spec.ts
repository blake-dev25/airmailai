import { expect, test } from './fixtures';

test('bulk export then import restores deleted chats', async ({
    courierai,
}) => {
    await courierai.goto();
    courierai.page.on('dialog', (dialog) => void dialog.accept());

    await courierai.send('Say the word apples and nothing else.');
    const original = (await courierai.persistedTexts('assistant')).at(-1) ?? '';
    expect(original.length).toBeGreaterThan(0);

    await courierai.openSettings();
    const dialog = courierai.settingsDialog();
    await courierai.settingsTab('Local Storage').click();

    const downloadPromise = courierai.page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Export all chats' }).click();
    const download = await downloadPromise;
    const backupPath = test.info().outputPath('courierai-backup.yaml');
    await download.saveAs(backupPath);

    await dialog.getByRole('button', { name: 'Delete chat history' }).click();
    await expect
        .poll(async () => (await courierai.readDb()).metas.length)
        .toBe(0);

    await dialog.locator('input[type="file"]').setInputFiles(backupPath);
    await expect
        .poll(async () => (await courierai.readDb()).metas.length)
        .toBe(1);

    await courierai.closeSettings();
    await courierai.page.getByRole('button', { name: /apples/i }).click();
    await expect(courierai.userMessages().first()).toContainText('apples');
    expect((await courierai.persistedTexts('assistant')).at(-1) ?? '').toBe(
        original
    );
});
