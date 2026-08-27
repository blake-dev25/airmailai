# End-to-end tests (Playwright)

Drives the real web app in Chrome with the AirmailAI extension loaded, against
real provider APIs. The harness launches Chrome with the unpacked extension
and seeds a fresh, isolated profile each run.

## Setup

1. `bun install`
2. Copy `.env.example` to `.env` (repo root) and fill in the four
   `*_API_KEY` values. The fixture seeds these into the extension's storage.

3. `bunx playwright install chromium`

Uses Playwright's bundled Chromium, not system Chrome: stable Chrome (~137+)
blocks the `--load-extension` flag this harness depends on, while bundled
Chromium still honors it.

## Run

Always go through the project-local binary (`bun run`), not `bunx playwright` -
`bunx` can resolve a mismatched runner instance and fail with "did not expect
test() to be called here".

```
bun run test               # all specs
bun run test smoke         # one file
bun run test --ui          # interactive (time-travel DOM snapshots)
```

## Notes

- **Cost:** specs hit real providers with cheap models.
- **Isolation:** each run uses an ephemeral browser profile, seeded with keys +
  `legalAcceptedVersion` + `smoothTextMode: 'raw'`. It never touches your real
  Chrome profile, so deleting chats / exercising key UI here is safe.
- **Headed:** runs headed because MV3 extensions don't load in old headless.
- **Source of truth / round trip:** persistence assertions check _both_ sides -
  the DOM and the extension's IndexedDB (read directly via the service worker).
  `airmailai.expectAssistantRoundTrip()` ties them together: it confirms the
  same reply that rendered also persisted (normalized-equal by default; pass
  `{ mode: 'contains' }` for web-search turns, whose link URLs / Sources UI live
  on only one side). Lower-level helpers: `readDb()`, `persistedTexts()`,
  `persistedSourceUrls()`.
- **Model selection:** specs never name a model. The fixture seeds
  `modelTier: 'test'`, which narrows each first-party provider to the single
  model tagged `['<tier>', 'test']` in
  `packages/airmailai_web/src/lib/models/tiers.ts`, and `models.ts` resolves
  that model into `PROVIDER_MODELS` (id, display name, context window). A new
  model release is therefore a one-line move of the `'test'` tag in
  `tiers.ts` - no spec edits. OpenRouter bypasses tier curation, so its entries
  pin `~vendor/*-latest` ids, which stay valid on their own.
- **No-key tests:** a spec can opt out of key seeding with
  `test.use({ seedApiKeys: false })` to exercise the "No API key saved" error
  path with zero API cost (see `errors.spec.ts`).
- **Feature seeding:** server tools and file uploads default off in the app,
  so specs opt in via `test.use({ seedWebSearchEnabled: true })` /
  `seedWebFetchEnabled` / `seedCodeExecEnabled` / `seedFileUploadsEnabled`.
- **Native dialogs:** destructive actions (chat delete, clear storage) go
  through `confirm()`. Playwright dismisses dialogs by default, so specs that
  exercise them register `page.on('dialog', (d) => void d.accept())` first.
- **OpenRouter catalog:** the fixture pre-seeds the extension's
  `openrouter_models_cache` (the two models the OR specs select) alongside the
  keys, so app boot serves the catalog from cache instead of doing a live
  `GET /models/user` on every test. The OpenRouter specs still make real OR chat calls.
- **Console log:** page warnings/errors + uncaught errors are written to
  `test-results/<test>/console-warnings.log` and echoed to the terminal when
  any occur - a focused view without digging through the full trace. The app's
  normal `console.log` chatter is excluded.
