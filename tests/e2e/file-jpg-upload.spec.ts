import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, TOOL_TURN_TIMEOUT } from './fixtures';

test.use({ seedFileUploadsEnabled: true });

const CASES = [
    { ext: 'jpg', mime: 'image/jpeg' },
    { ext: 'png', mime: 'image/png' },
] as const;

for (const { ext, mime } of CASES) {
    test(`image upload (${ext}): model describes the attached photo`, async ({
        airmailai,
    }) => {
        test.setTimeout(120_000);
        const name = `vision-test.${ext}`;
        const buffer = readFileSync(path.join(__dirname, 'files', name));

        await airmailai.goto();
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
