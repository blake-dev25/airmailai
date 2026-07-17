import { PDFDocument, StandardFonts } from 'pdf-lib';
import { expect, test, TOOL_TURN_TIMEOUT } from './fixtures';

test.use({ seedFileUploadsEnabled: true });

test('PDF upload: model reads text from an attached PDF', async ({
    courierai,
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

    await courierai.goto();
    await courierai.attachFile({
        name: 'sample.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from(bytes),
    });
    await courierai.send(
        'What number is in this document? Reply with just the number.',
        { turnTimeout: TOOL_TURN_TIMEOUT }
    );

    await courierai.expectAssistantRoundTrip(n, { mode: 'contains' });
    expect(
        (await courierai.persistedTexts('assistant')).at(-1) ?? ''
    ).toContain(n);
    expect(await courierai.persistedFileNames('user')).toContain('sample.pdf');
});
