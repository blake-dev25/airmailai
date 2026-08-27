import { expect, PROVIDER_MODELS, test } from './fixtures';

test('New Chat button creates a fresh empty chat', async ({ airmailai }) => {
    await airmailai.goto();
    await airmailai.send('Say the word apples and nothing else.');

    await airmailai.newChatButton().click();

    await expect(
        airmailai.page.getByText('Start a conversation')
    ).toBeVisible();
    await expect(airmailai.assistantMessages()).toHaveCount(0);
    await expect(airmailai.composer()).toHaveValue('');
});

test('switching between chats loads the correct history', async ({
    airmailai,
}) => {
    await airmailai.goto();

    await airmailai.send('Say the word apples and nothing else.');
    await airmailai.newChatButton().click();
    await airmailai.send('Say the word bananas and nothing else.');

    await airmailai.page.getByRole('button', { name: /apples/i }).click();

    await expect(airmailai.userMessages().first()).toContainText('apples');
    await expect(airmailai.userMessages()).toHaveCount(1);
});

test('deleting a chat removes it from the sidebar and storage', async ({
    airmailai,
}) => {
    await airmailai.goto();
    airmailai.page.on('dialog', (dialog) => void dialog.accept());

    await airmailai.send('Say the word apples and nothing else.');
    await airmailai.newChatButton().click();
    await airmailai.send('Say the word bananas and nothing else.');

    const applesRow = airmailai.page
        .getByRole('button', { name: /apples/i })
        .locator('..');
    await applesRow.getByRole('button', { name: 'Chat options' }).click();
    await airmailai.page
        .getByRole('button', { name: 'Delete', exact: true })
        .click();

    await expect(
        airmailai.page.getByRole('button', { name: /apples/i })
    ).toHaveCount(0);
    await expect(
        airmailai.page.getByRole('button', { name: /bananas/i })
    ).toBeVisible();

    await expect
        .poll(async () => (await airmailai.readDb()).metas.length)
        .toBe(1);
    const { metas } = await airmailai.readDb();
    expect(metas[0].title).toContain('bananas');
});

test('search box filters chats by content', async ({ airmailai }) => {
    await airmailai.goto();

    await airmailai.send('Say the word apples and nothing else.');
    await airmailai.newChatButton().click();
    await airmailai.send('Say the word bananas and nothing else.');

    await airmailai.page.getByPlaceholder('Search').fill('apples');
    await airmailai.page.getByPlaceholder('Search').press('Enter');

    const results = airmailai.page.getByRole('navigation', {
        name: 'Search results',
    });
    await expect(results).toBeVisible();
    await expect(results).toContainText('apples');
    await expect(results).not.toContainText('bananas');
});

test('renaming a chat updates the sidebar and persists', async ({
    airmailai,
}) => {
    await airmailai.goto();
    await airmailai.send('Say the word apples and nothing else.');

    await airmailai.page.getByRole('button', { name: 'Chat options' }).click();
    await airmailai.page.getByRole('button', { name: 'Rename' }).click();
    const renameInput = airmailai.page
        .getByRole('navigation', { name: 'Chat history' })
        .getByRole('textbox');
    await renameInput.fill('Renamed Chat');
    await renameInput.press('Enter');

    await expect(
        airmailai.page.getByRole('button', { name: /Renamed Chat/ })
    ).toBeVisible();

    const { metas } = await airmailai.readDb();
    expect(metas[0].title).toBe('Renamed Chat');
});

test('chats and messages persist across reload', async ({ airmailai }) => {
    await airmailai.goto();
    await airmailai.send('Say the word apples and nothing else.');

    await airmailai.page.reload();
    await expect(airmailai.composer()).toBeVisible();

    const entry = airmailai.page.getByRole('button', { name: /apples/i });
    await expect(entry).toBeVisible();
    await entry.click();
    await expect(airmailai.userMessages().first()).toContainText('apples');
});

test('model config persists across reload', async ({ airmailai }) => {
    await airmailai.goto();

    const openai = PROVIDER_MODELS.openai;
    await airmailai.setProvider(openai.label);
    await airmailai.setModelById(openai.chat);
    await airmailai.setMaxTokens(5);
    await airmailai.page.waitForTimeout(500);

    await airmailai.page.reload();
    await expect(airmailai.composer()).toBeVisible();

    await expect(airmailai.providerSelect()).toHaveValue('openai');
    await expect(airmailai.modelTrigger()).toContainText(openai.chatName);
    await expect(airmailai.maxTokensBadge()).toHaveText('5');
});
