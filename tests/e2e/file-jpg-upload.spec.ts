import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, PROVIDER_MODELS, test, TOOL_TURN_TIMEOUT } from './fixtures';

test.use({ seedFileUploadsEnabled: true });

const CASES = [
    { ext: 'jpg', mime: 'image/jpeg' },
    { ext: 'png', mime: 'image/png' },
] as const;

const TARGETS = [
    { suffix: '', openRouter: false },
    { suffix: ' on OpenRouter', openRouter: true },
] as const;

for (const { ext, mime } of CASES) {
    for (const { suffix, openRouter } of TARGETS) {
        test(`image upload (${ext})${suffix}: model describes the attached photo`, async ({
            airmailai,
        }) => {
            test.setTimeout(120_000);
            const name = `vision-test.${ext}`;
            const buffer = readFileSync(path.join(__dirname, 'files', name));

            await airmailai.goto();
            if (openRouter) {
                const { label, chat, chatName } = PROVIDER_MODELS.openrouter;
                await airmailai.setProvider(label);
                await airmailai.waitForOpenRouterCatalog();
                await airmailai.setModelById(chat);
                await expect(airmailai.modelTrigger()).toContainText(chatName);
            }
            await airmailai.attachFile({ name, mimeType: mime, buffer });
            await airmailai.send(
                'In a few words, what is the main subject of this image?',
                { turnTimeout: TOOL_TURN_TIMEOUT }
            );

            await airmailai.expectAssistantRoundTrip(
                /sunset|sunrise|ocean|sea|beach|sky|horizon|waves?/i
            );

            await expect(
                airmailai.userMessages().first().getByRole('img', { name })
            ).toBeVisible();
            expect(await airmailai.persistedFileNames('user')).toContain(name);
        });
    }
}
