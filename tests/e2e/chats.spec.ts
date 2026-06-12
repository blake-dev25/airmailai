import { expect, test } from './fixtures';

test('New Chat button creates a fresh empty chat', async ({ courierai }) => {
    await courierai.goto();
    await courierai.send('Say the word apples and nothing else.');

    await courierai.newChatButton().click();

    await expect(
        courierai.page.getByText('Start a conversation')
    ).toBeVisible();
    await expect(courierai.assistantMessages()).toHaveCount(0);
    await expect(courierai.composer()).toHaveValue('');
});

test('switching between chats loads the correct history', async ({
    courierai,
}) => {
    await courierai.goto();

    await courierai.send('Say the word apples and nothing else.');
    await courierai.newChatButton().click();
    await courierai.send('Say the word bananas and nothing else.');

    await courierai.page.getByRole('button', { name: /apples/i }).click();

    await expect(courierai.userMessages().first()).toContainText('apples');
    await expect(courierai.userMessages()).toHaveCount(1);
});

test('deleting a chat removes it from the sidebar and storage', async ({
    courierai,
}) => {
    await courierai.goto();

    await courierai.send('Say the word apples and nothing else.');
    await courierai.newChatButton().click();
    await courierai.send('Say the word bananas and nothing else.');

    const applesRow = courierai.page
        .getByRole('button', { name: /apples/i })
        .locator('..');
    await applesRow.getByRole('button', { name: 'Chat options' }).click();
    await courierai.page
        .getByRole('button', { name: 'Delete', exact: true })
        .click();

    await expect(
        courierai.page.getByRole('button', { name: /apples/i })
    ).toHaveCount(0);
    await expect(
        courierai.page.getByRole('button', { name: /bananas/i })
    ).toBeVisible();

    await expect
        .poll(async () => (await courierai.readDb()).metas.length)
        .toBe(1);
    const { metas } = await courierai.readDb();
    expect(metas[0].title).toContain('bananas');
});

test('search box filters chats by content', async ({ courierai }) => {
    await courierai.goto();

    await courierai.send('Say the word apples and nothing else.');
    await courierai.newChatButton().click();
    await courierai.send('Say the word bananas and nothing else.');

    await courierai.page.getByPlaceholder('Search').fill('apples');
    await courierai.page.getByPlaceholder('Search').press('Enter');

    const results = courierai.page.getByRole('navigation', {
        name: 'Search results',
    });
    await expect(results).toBeVisible();
    await expect(results).toContainText('apples');
    await expect(results).not.toContainText('bananas');
});

test('renaming a chat updates the sidebar and persists', async ({
    courierai,
}) => {
    await courierai.goto();
    await courierai.send('Say the word apples and nothing else.');

    await courierai.page.getByRole('button', { name: 'Chat options' }).click();
    await courierai.page.getByRole('button', { name: 'Rename' }).click();
    const renameInput = courierai.page
        .getByRole('navigation', { name: 'Chat history' })
        .getByRole('textbox');
    await renameInput.fill('Renamed Chat');
    await renameInput.press('Enter');

    await expect(
        courierai.page.getByRole('button', { name: /Renamed Chat/ })
    ).toBeVisible();

    const { metas } = await courierai.readDb();
    expect(metas[0].title).toBe('Renamed Chat');
});

test('chats and messages persist across reload', async ({ courierai }) => {
    await courierai.goto();
    await courierai.send('Say the word apples and nothing else.');

    await courierai.page.reload();
    await expect(courierai.composer()).toBeVisible();

    const entry = courierai.page.getByRole('button', { name: /apples/i });
    await expect(entry).toBeVisible();
    await entry.click();
    await expect(courierai.userMessages().first()).toContainText('apples');
});

test('model config persists across reload', async ({ courierai }) => {
    await courierai.goto();

    await courierai.setProvider('OpenAI');
    await courierai.setModelById('gpt-5.4-mini');
    await courierai.setMaxTokens(5);
    await courierai.page.waitForTimeout(500);

    await courierai.page.reload();
    await expect(courierai.composer()).toBeVisible();

    await expect(courierai.providerSelect()).toHaveValue('openai');
    await expect(courierai.modelTrigger()).toContainText('GPT-5.4 Mini');
    await expect(courierai.maxTokensBadge()).toHaveText('5');
});
