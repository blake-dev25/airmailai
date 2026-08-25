import { expect, PROVIDER_MODELS, test } from './fixtures';

test.describe('no API key seeded', () => {
    test.use({ seedApiKeys: false });

    test('missing key surfaces a loud, dismissible error and persists no assistant', async ({
        airmailai,
    }) => {
        await airmailai.goto();
        await airmailai.compose('hello');

        const error = airmailai.appError();
        await expect(error).toBeVisible();
        await expect(error).toContainText(/no api key/i);

        const { messages } = await airmailai.readDb();
        expect(
            messages.filter((m) => m.message.role === 'assistant')
        ).toHaveLength(0);

        await airmailai.page
            .getByRole('button', { name: 'Dismiss error' })
            .click();
        await expect(error).toBeHidden();
    });
});

test('OpenAI rejects sub-16 max tokens with a loud error', async ({
    airmailai,
}) => {
    await airmailai.goto();

    await airmailai.setProvider('OpenAI');
    await expect(airmailai.modelTrigger()).toContainText(
        PROVIDER_MODELS.openai.chatName
    );

    await airmailai.setMaxTokens(5);
    await airmailai.compose('Write a short story about the ocean.');

    const error = airmailai.appError();
    await expect(error).toBeVisible();
    await expect(error).toContainText(/error/i);
});

test.describe('turn persistence failures', () => {
    for (const storeName of ['chat_meta', 'chat_messages']) {
        test(`${storeName} failure preserves the composer and does not stream`, async ({
            airmailai,
        }) => {
            await airmailai.goto();
            await airmailai.failNextDbPut(storeName);
            await airmailai.compose('Keep this unsent message');

            await expect(airmailai.appError()).toContainText(
                /couldn't save your message/i
            );
            await expect(airmailai.composer()).toHaveValue(
                'Keep this unsent message'
            );
            await expect(airmailai.stopButton()).toBeHidden();
            await expect(airmailai.userMessages()).toHaveCount(0);
            await expect(airmailai.assistantMessages()).toHaveCount(0);

            const { metas, messages } = await airmailai.readDb();
            expect(metas).toHaveLength(0);
            expect(messages).toHaveLength(0);
        });
    }

    test('retry truncation failure restores the original branch and does not stream', async ({
        airmailai,
    }) => {
        await airmailai.goto();
        await airmailai.send('Reply with exactly: pong');
        const originalAssistant = await airmailai.lastAssistantText();
        const originalDb = await airmailai.readDb();

        await airmailai.failNextCursorDelete();
        const assistant = airmailai.assistantMessages().last();
        await assistant.hover();
        await assistant.getByRole('button', { name: 'Retry' }).click();

        await expect(airmailai.appError()).toContainText(
            /couldn't prepare chat retry/i
        );
        await expect(airmailai.stopButton()).toBeHidden();
        await expect(airmailai.assistantMessages()).toHaveCount(1);
        expect(await airmailai.lastAssistantText()).toBe(originalAssistant);

        const currentDb = await airmailai.readDb();
        expect(currentDb.metas).toEqual(originalDb.metas);
        expect(currentDb.messages).toEqual(originalDb.messages);
    });

    test('put_message rejects a missing chat', async ({ airmailai }) => {
        await airmailai.goto();
        const response = await airmailai.sendStorageRequest({
            type: 'put_message',
            message: {
                chatId: 'missing-chat',
                message: {
                    id: 'orphan-message',
                    role: 'user',
                    parts: [{ type: 'text', text: 'orphan', state: 'done' }],
                    metadata: { createdAt: Date.now() },
                },
            },
        });

        expect(response.type).toBe('error');
        expect(response.message).toMatch(/chat missing-chat not found/i);
    });
});
