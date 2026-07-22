# AirmailAI

TODO: add small logo/title image

**[airmailai.net](https://airmailai.net)** / [FAQ](https://airmailai.net/faq/) / [@airmailai](https://x.com/airmailai)

AirmailAI is a fast, secure, and private bring-your-own-keys LLM chat app.

## How it works

AirmailAI is two pieces:

- **Website** ([packages/airmailai_web](packages/airmailai_web)) - the chat interface. We host this at [airmailai.net](https://airmailai.net).
- **Browser Extension** ([packages/airmailai_ext](packages/airmailai_ext)) - the local backend that stores your API keys/settings/chat history and makes the actual provider API calls. You can install it from the Chrome Web Store (TODO: link).

You can also build and run AirmailAI locally, see below.

## Design

- **No AirmailAI backend servers.** The hosted website is static files served from a CDN. Even when you use the official AirmailAI website, requests go directly from your browser to the provider.
- **Keys are write-only.** The website can ask the extension to use or delete a saved key, but there is intentionally no code path for reading one back - not even for the official AirmailAI website.
- **AirmailAI stores your data locally.** Chats, local file copies, and API keys are stored by the extension. UI/model settings can sync through your browser account.

## Features

- Support for OpenAI, Anthropic, Google, and OpenRouter APIs in one chat UI
- Streaming chat with reasoning/thinking, web search, and code execution
- File uploads (images, PDFs, and more, depending on the provider)
- Chat import and export - supports AirmailAI, LM Studio, and SillyTavern formats
- Support for free models through OpenRouter

## Getting started

1. Install the browser extension (TODO: CWS link). Works on any Chromium-based browser like Chrome, Edge, or Brave.
2. Open [airmailai.net/app](https://airmailai.net/app/).
3. Add API keys for the providers you want to use and start chatting.

## Building from source

Requires [Bun](https://bun.sh).

```sh
bun install
bun run build
```

`bun run build` lints, type-checks, builds the website into `packages/airmailai_web/dist/`, and builds the extension into `packages/airmailai_ext/.output/`.
To load the extension: open `chrome://extensions`, enable Developer mode, click "Load unpacked", and select `packages/airmailai_ext/.output/chrome-mv3`.
To run the website:
(TODO: add)

## Feedback / Contributing

Bug reports and feature requests are welcome - [open an issue](https://github.com/blake-dev25/airmailai/issues). If you hit an error, include what happened, what you expected, your browser, and the error message.

Never include API keys, private conversations, or other sensitive information in a public issue.

AirmailAI is not currently accepting PRs.

## Security

Please do not report security vulnerabilities through public GitHub issues. Report them privately by emailing [security@blake-dev.net](mailto:security@blake-dev.net) with a description of the issue and, when possible, steps to reproduce it.

Please do not include API keys, private conversations, or other sensitive information in your email.

## License

AirmailAI is licensed under the [Apache License 2.0](LICENSE).

## Credits

AirmailAI is built and maintained by Blake Dev (TODO: website link), with AI assistance.
