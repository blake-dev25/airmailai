# CourierAI

The lightweight, security-first, privacy-focused BYOK LLM chat app.

**[courierai.net](https://courierai.net)** · [FAQ](https://courierai.net/faq/) · [@CourierAIapp](https://x.com/CourierAIapp)

CourierAI lets you chat with frontier models from multiple providers using your own API keys. No accounts, no subscriptions, no markup - you pay providers for exactly the tokens you use.

## How it works

CourierAI is two pieces:

- **Website** ([packages/courierai_web](packages/courierai_web)) - the chat interface and settings UI. Static files served from a CDN. It holds all provider/model constants, so new model releases roll out in minutes without waiting on an extension store review.
- **Extension** ([packages/courierai_ext](packages/courierai_ext)) - a slim middleman that stores your API keys, settings, and chat history, and makes the actual provider API calls. After installing it, you never need to interact with it directly.

The privacy properties fall out of the architecture rather than a policy:

- **No CourierAI servers.** Requests go straight from your browser to the provider. There is nothing in the middle to log, retain, or leak your conversations.
- **Keys are write-only.** The website can ask the extension to use or delete a saved key, but there is intentionally no code path for reading one back - not even for courierai.net itself.
- **Everything stays on your device.** Chats and keys are stored locally by the extension.

This repository being source-available is part of that story: you can verify all of the above yourself.

## Getting started

1. Install the browser extension (Chrome Web Store link coming soon; until then, build from source below). Works on any Chromium-based browser.
2. Open [courierai.net/app](https://courierai.net/app/).
3. Add API keys for the providers you want to use and start chatting.

## Building from source

Requires [Bun](https://bun.sh).

```sh
bun install
bun run build
```

`bun run build` lints, type-checks, builds the website into `packages/courierai_web/dist/`, and builds the extension into `packages/courierai_ext/.output/`. To load the extension: open `chrome://extensions`, enable Developer mode, click "Load unpacked", and select `packages/courierai_ext/.output/chrome-mv3`.

## Feedback

Bug reports and feature requests are welcome - [open an issue](https://github.com/blake-dev25/courierai/issues). If you hit an error, include what happened, what you expected, your browser, and the error message.