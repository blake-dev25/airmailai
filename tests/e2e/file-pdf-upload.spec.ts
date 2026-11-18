import { PDFDocument, StandardFonts } from 'pdf-lib';
import { expect, PROVIDER_MODELS, test, TOOL_TURN_TIMEOUT } from './fixtures';

test.use({ seedFileUploadsEnabled: true });

const TARGETS = [
    { suffix: '', openRouter: false },
    { suffix: ' on OpenRouter', openRouter: true },
] as const;

for (const { suffix, openRouter } of TARGETS) {
    test(`PDF upload${suffix}: model reads text from an attached PDF`, async ({
        airmailai,
    }) => {
        test.setTimeout(120_000);
        const n = String(Math.floor(100000 + Math.random() * 900000));
        const doc = await PDFDocument.create();
        const font = await doc.embedFont(StandardFonts.Helvetica);
        doc.addPage().drawText(`this is a test. the number is ${n}`, {
            x: 50,
            y: 700,
            size: 18,
            font,
        });
        const bytes = await doc.save();

        await airmailai.goto();
        if (openRouter) {
            const { label, chat, chatName } = PROVIDER_MODELS.openrouter;
            await airmailai.setProvider(label);
            await airmailai.waitForOpenRouterCatalog();
            await airmailai.setModelById(chat);
            await expect(airmailai.modelTrigger()).toContainText(chatName);
        }
        await airmailai.attachFile({
            name: 'sample.pdf',
            mimeType: 'application/pdf',
            buffer: Buffer.from(bytes),
        });
        await airmailai.send(
            'What number is in this document? Reply with just the number.',
            { turnTimeout: TOOL_TURN_TIMEOUT }
        );

        await airmailai.expectAssistantRoundTrip(n, { mode: 'contains' });
        expect(await airmailai.persistedFileNames('user')).toContain(
            'sample.pdf'
        );
    });
}
