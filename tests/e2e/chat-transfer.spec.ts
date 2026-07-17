import { expect, test } from './fixtures';

test('bulk export then import restores deleted chats', async ({
    airmailai,
}) => {
    await airmailai.goto();
    airmailai.page.on('dialog', (dialog) => void dialog.accept());

    await airmailai.send('Say the word apples and nothing else.');
    const original = (await airmailai.persistedTexts('assistant')).at(-1) ?? '';
    expect(original.length).toBeGreaterThan(0);

    await airmailai.openSettings();
    const dialog = airmailai.settingsDialog();
    await airmailai.settingsTab('Local Storage').click();

    const downloadPromise = airmailai.page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Export all chats' }).click();
    const download = await downloadPromise;
    const backupPath = test.info().outputPath('airmailai-backup.yaml');
    await download.saveAs(backupPath);

    await dialog.getByRole('button', { name: 'Delete chat history' }).click();
    await expect
        .poll(async () => (await airmailai.readDb()).metas.length)
        .toBe(0);

    await dialog.locator('input[type="file"]').setInputFiles(backupPath);
    await expect
        .poll(async () => (await airmailai.readDb()).metas.length)
        .toBe(1);

    await airmailai.closeSettings();
    await airmailai.page.getByRole('button', { name: /apples/i }).click();
    await expect(airmailai.userMessages().first()).toContainText('apples');
    expect((await airmailai.persistedTexts('assistant')).at(-1) ?? '').toBe(
        original
    );
});
