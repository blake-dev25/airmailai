import { expect, test } from './fixtures';

test('OpenRouter custom model responds with optional settings blank', async ({
    airmailai,
}) => {
    await airmailai.goto();
    await airmailai.setProvider('OpenRouter');
    await airmailai.openSettings();
    await airmailai.settingsTab('Advanced').click();
    await airmailai
        .settingsDialog()
        .getByRole('switch', { name: 'Custom Model Configuration' })
        .click();
    await airmailai.closeSettings();

    await airmailai.page
        .getByRole('textbox', { name: 'Model', exact: true })
        .fill('~openai/gpt-latest');
    for (const name of ['Temperature', 'Max Output Tokens', 'Thinking Level']) {
        await expect(
            airmailai.page.getByRole('textbox', { name, exact: true })
        ).toHaveValue('');
    }

    await airmailai.send('test');
    await expect(airmailai.appError()).toBeHidden();
});
