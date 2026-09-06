<p align="center">
  <a href="https://airmailai.net">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://airmailai.net/airmailai-logo-wordmark-dark.svg">
      <img src="https://airmailai.net/airmailai-logo-wordmark.svg" alt="AirmailAI" height="64">
    </picture>
  </a>
</p>

<p align="center">
  <strong><a href="https://airmailai.net">airmailai.net</a></strong> / <a href="https://airmailai.net/faq/">FAQ</a> / <a href="https://airmailai.net/design-security/">Design &amp; Security</a> / <a href="https://x.com/airmailai">@airmailai</a>
</p>

## AirmailAI

AirmailAI is a fast, secure, and private bring-your-own-keys LLM chat app.

## How it works

AirmailAI is two pieces:

- **Website** ([packages/airmailai_web](packages/airmailai_web)) - the chat UI, which is hosted at [airmailai.net](https://airmailai.net).
- **Browser Extension** ([packages/airmailai_ext](packages/airmailai_ext)) - stores your API keys, settings, and chat history locally, and makes the provider API calls.

For more details including how AirmailAI handles your data, see the [FAQ](https://airmailai.net/faq/) and [Design & Security](https://airmailai.net/design-security/) pages.

## Getting started

1. Install the browser extension (TODO: CWS link). Works on any Chromium-based browser like Chrome, Edge, or Brave.
2. Open [airmailai.net/app](https://airmailai.net/app/).
3. Add API keys for the providers you want to use and start chatting.

## Supported APIs

AirmailAI currently supports the following LLM APIs:
- OpenAI
- Anthropic
- Google
- OpenRouter

## Running locally

Requires [Bun](https://bun.sh) and a Chromium-based browser.

```sh
bun install
bun run build:local
bun run start:web
```

1. `bun run build:local` builds the extension into `packages/airmailai_ext/.output/chrome-mv3` with localhost access enabled. The Chrome Web Store version only talks to airmailai.net, so a local website needs this local build.
2. Load the extension: open `chrome://extensions`, enable Developer mode, click "Load unpacked", and select `packages/airmailai_ext/.output/chrome-mv3`.
3. `bun run start:web` builds the website and serves it at `http://localhost:4173`, opening the app in your browser. Leave it running while you use AirmailAI. Re-run it after pulling updates.

Local builds use the same ID as the store listing: `mpffonlfgjkbmgdnbpghihbgkmgnfhlo`. The website probes this ID directly to detect the extension and read its version. If needed, use a separate browser profile for local development to keep test chats and settings separate from your regular profile.

## Building

```sh
bun run build
```

`bun run build` lints, type-checks, builds the website into `packages/airmailai_web/dist/`, and builds the extension into `packages/airmailai_ext/.output/`.

## Feedback / Contributing

Bug reports and feature requests are welcome, feel free to [open an issue](https://github.com/blake-dev25/airmailai/issues). If you hit an error, include what happened, what you expected, your browser, and the error message.

Never include API keys, private conversations, or other sensitive information in a public issue.

AirmailAI is not currently accepting PRs.

## Security

Please do not report security vulnerabilities through public GitHub issues. Report them privately by emailing [security@blake-dev.net](mailto:security@blake-dev.net) with a description of the issue and, when possible, steps to reproduce it.

Please do not include API keys, private conversations, or other sensitive information in your email.

## License

AirmailAI is licensed under the [Apache License 2.0](LICENSE).

## Credits

AirmailAI is built and maintained by [Blake Dev](https://blake-dev.net) with AI assistance.
