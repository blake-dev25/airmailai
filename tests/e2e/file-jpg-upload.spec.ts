import { test } from './fixtures';

// TODO: image (vision) upload e2e. Blocked on the file-upload feature landing.
//
// Uses a COMMITTED real photo (not generated) so we test that the model
// actually "sees" the image. The fixture is a sunset over the ocean, committed
// as the SAME picture in two formats - tests/e2e/files/vision-test.jpg and
// vision-test.png - so format is the variable under test and content stays
// controlled. Provenance is in tests/e2e/files/README.md.
//
// Plan:
// - Parametrize over { ext: 'jpg', mime: 'image/jpeg' } and { ext: 'png',
//   mime: 'image/png' }:
//     const img = readFileSync(path.join(__dirname, 'files', `vision-test.${ext}`));
// - Attach via the hidden <input type="file"> (buffer form, no temp file):
//     await courierai.page.locator('input[type=file]').setInputFiles({
//         name: `vision-test.${ext}`, mimeType: mime, buffer: img,
//     });
//   (swap for a courierai.attachFile() helper once it exists)
// - Ask: "In a few words, what is the main subject of this image?"
// - Vision assert: the picture is a sunset over the ocean, so the reply should
//   match /sunset|sunrise|ocean|sea|beach|sky|horizon|waves?/i.
// - Keep the comprehension assertion on ONE cheap vision-capable model; optionally
//   smoke "file accepted + reply returned" across the other providers to limit
//   cost + flake.

test.fixme('image upload: model describes an attached photo', async () => {
    // TODO: implement once file upload lands
});
