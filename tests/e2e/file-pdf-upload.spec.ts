import { test } from './fixtures';

// TODO: PDF upload e2e. Blocked on the file-upload feature landing.
//
// The PDF is generated in-memory (no committed fixture) so we control its text
// and can assert the model read it back.
//
// Plan:
// - Generate a small PDF with pdf-lib embedding a per-run RANDOM 6-digit number,
//   so a pass proves the model read THIS upload, not stale context or a guess:
//     const n = String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
//     const doc = await PDFDocument.create();
//     const font = await doc.embedFont(StandardFonts.Helvetica);
//     doc.addPage().drawText(`this is a test. the number is ${n}`, { x: 50, y: 700, size: 18, font });
//     const bytes = await doc.save(); // Uint8Array
// - Attach via the hidden <input type="file"> (buffer form, no temp file):
//     await courierai.page.locator('input[type=file]').setInputFiles({
//         name: 'sample.pdf', mimeType: 'application/pdf', buffer: Buffer.from(bytes),
//     });
//   (swap for a courierai.attachFile() helper once it exists)
// - Ask the model "What number is in this document?"; assert the reply contains n.
// - Round-trip: courierai.expectAssistantRoundTrip(...) + persisted attachment part.
// - Consider looping PROVIDER_MODELS for cross-provider coverage.

test.fixme('PDF upload: model reads text from an attached PDF', async () => {
    // TODO: implement once file upload lands
});
