import { defaultModelForProvider } from '../../packages/airmailai_web/src/lib/models';
import { expect, PROVIDER_MODELS, test } from './fixtures';
import { DEFAULT_MODEL_PARAMS, DEFAULT_PROVIDER, PROVIDERS } from './models';

const UNAVAILABLE_MODEL_ID = 'claude-retired-e2e-model';
const GITHUB_ISSUES_URL = 'https://github.com/blake-dev25/airmailai/issues/';

function providerDefaultName(): string {
    const provider = PROVIDERS.find((p) => p.id === DEFAULT_PROVIDER);
    const model = provider && defaultModelForProvider(provider);
    if (!model) throw new Error(`No default model for ${DEFAULT_PROVIDER}`);
    return model.name;
}

test('boot with an unavailable selected model warns and switches to the provider default', async ({
    airmailai,
    serviceWorker,
}) => {
    await serviceWorker.evaluate(
        (modelId) => chrome.storage.sync.set({ modelId }),
        UNAVAILABLE_MODEL_ID
    );
    await airmailai.goto();

    const warning = airmailai.page.getByTestId('model-unavailable-warning');
    await expect(warning).toContainText(
        `Warning: previously selected model '${UNAVAILABLE_MODEL_ID}' is not available.`
    );
    await expect(warning.getByRole('link', { name: 'GitHub' })).toHaveAttribute(
        'href',
        GITHUB_ISSUES_URL
    );
    await expect(airmailai.modelTrigger()).toContainText(providerDefaultName());

    await warning.getByRole('button', { name: 'Dismiss warning' }).click();
    await expect(warning).toBeHidden();
});

test('opening a chat with an unavailable model warns and switches to the provider default', async ({
    airmailai,
}) => {
    await airmailai.goto();
    const response = await airmailai.sendStorageRequest({
        type: 'save_meta',
        meta: {
            customModel: null,
            id: 'unavailable-model-chat',
            title: 'Retired model chat',
            createdAt: Date.now(),
            providerId: DEFAULT_PROVIDER,
            modelId: UNAVAILABLE_MODEL_ID,
            temperature: 1,
            maxTokens: DEFAULT_MODEL_PARAMS.defaultMaxTokens,
            thinkingLevel: 'none',
            adaptiveThinking: false,
            webSearch: false,
            webFetch: false,
            codeExecution: false,
            systemPrompt: '',
        },
    });
    expect(response.type).toBe('saved');

    await airmailai.page.reload();
    await expect(airmailai.composer()).toBeVisible();
    const warning = airmailai.page.getByTestId('model-unavailable-warning');
    await expect(warning).toBeHidden();
    await expect(airmailai.modelTrigger()).toContainText(
        PROVIDER_MODELS.anthropic.chatName
    );

    await airmailai.page
        .getByRole('button', { name: /Retired model chat/ })
        .click();

    await expect(warning).toContainText(
        `Warning: previously selected model '${UNAVAILABLE_MODEL_ID}' is not available.`
    );
    await expect(airmailai.modelTrigger()).toContainText(providerDefaultName());
});
