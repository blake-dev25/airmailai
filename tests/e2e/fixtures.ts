import './env';
import {
    test as base,
    expect,
    chromium,
    type BrowserContext,
    type Locator,
    type Page,
    type Worker,
} from '@playwright/test';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
    CACHE_KEY as OPENROUTER_CACHE_KEY,
    CACHE_VERSION as OPENROUTER_CACHE_VERSION,
} from '../../packages/courierai_ext/openrouter-models';
import {
    DEFAULT_MODEL,
    DEFAULT_PROVIDER,
    OPENROUTER_CACHE_MODELS,
} from './models';

const ROOT = path.resolve(__dirname, '../..');
const EXT_PATH = path.join(
    ROOT,
    'packages',
    'courierai_ext',
    '.output',
    'chrome-mv3'
);
const LEGAL_DIR = path.join(
    ROOT,
    'packages',
    'courierai_web',
    'static',
    'legal'
);
const BASE_URL = process.env.COURIERAI_BASE_URL ?? 'http://localhost:5173';

// A DOM action settles in a few seconds, but a chat turn against a reasoning
// model can burn 10-20s thinking before any text lands (worse on tool turns),
// so cap waits at 30s - long enough to ride out the think, short enough that a
// genuine hang still surfaces well under the per-test ceiling.
export const QUICK_TIMEOUT = 30_000;
// Web-search / tool-call turns make an extra provider round trip, so they get a
// longer ceiling - the one exception to the <10s rule.
export const TOOL_TURN_TIMEOUT = 120_000;

const PROVIDER_ENV: Record<string, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    google: 'GOOGLE_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
};

// Mirror of readLegalVersion() in courierai_web/vite.config.ts. Seeding this
// into chrome.storage.sync satisfies the LegalGate without driving the consent
// UI (human-only by design).
function legalVersion(): string {
    const hash = createHash('sha256');
    for (const name of ['terms.md', 'privacy.md']) {
        hash.update(name);
        hash.update('\0');
        hash.update(
            readFileSync(path.join(LEGAL_DIR, name), 'utf-8').replace(
                /\r\n/g,
                '\n'
            )
        );
        hash.update('\0');
    }
    return hash.digest('hex');
}

function apiKeysFromEnv(): Record<string, string> {
    const keys: Record<string, string> = {};
    for (const [provider, envVar] of Object.entries(PROVIDER_ENV)) {
        const value = process.env[envVar];
        if (value) keys[`apiKey_${provider}`] = value;
    }
    if (!keys[`apiKey_${DEFAULT_PROVIDER}`]) {
        throw new Error(
            `${PROVIDER_ENV[DEFAULT_PROVIDER]} missing from .env - needed to seed the extension for tests.`
        );
    }
    return keys;
}

// Seed the fresh extension profile via the service worker (where chrome.* lives):
// API keys + OpenRouter catalog cache -> chrome.storage.local, settings ->
// chrome.storage.sync. With `withKeys: false` no keys (and no catalog cache)
// are seeded - used to exercise the "No API key saved" error path without any
// real API call. `webSearch` / `webFetch` / `codeExec` seed the matching master
// Advanced toggles (all default off), so the per-model tool control renders
// without driving the Settings UI for it.
async function seedExtension(
    sw: Worker,
    {
        withKeys,
        webSearch,
        webFetch,
        codeExec,
    }: {
        withKeys: boolean;
        webSearch: boolean;
        webFetch: boolean;
        codeExec: boolean;
    }
): Promise<void> {
    const local: Record<string, unknown> = withKeys ? apiKeysFromEnv() : {};
    // Pre-seed the OpenRouter catalog cache with a fresh fetchedAt so
    // getOpenRouterModels serves it without the network. Only meaningful with
    // the OR key seeded - without a key the cold-fetch path never fires.
    if (withKeys) {
        local[OPENROUTER_CACHE_KEY] = {
            version: OPENROUTER_CACHE_VERSION,
            models: OPENROUTER_CACHE_MODELS,
            fetchedAt: Date.now(),
        };
    }
    const settings: Record<string, unknown> = {
        legalAcceptedVersion: legalVersion(),
        smoothTextMode: 'raw',
        providerId: DEFAULT_PROVIDER,
        modelId: DEFAULT_MODEL,
    };
    if (webSearch) settings.enableWebSearch = true;
    if (webFetch) settings.enableWebFetch = true;
    if (codeExec) settings.enableCodeExecution = true;
    await sw.evaluate(
        async ({ local, settings }) => {
            if (Object.keys(local).length)
                await chrome.storage.local.set(local);
            await chrome.storage.sync.set(settings);
        },
        { local, settings }
    );
}

interface StoredMeta {
    id: string;
    title: string;
    [key: string]: unknown;
}
interface StoredMsg {
    chatId: string;
    message: {
        id: string;
        role: string;
        parts: {
            type: string;
            text?: string;
            url?: string;
            title?: string;
            name?: string;
        }[];
        metadata?: { createdAt?: number };
    };
}

// Text content of a stored message: its `text` parts joined. Mirrors what a
// bubble renders as body text - reasoning, tool, and source-url parts render
// as their own UI, so they're excluded here.
function storedMessageText(msg: StoredMsg): string {
    return msg.message.parts
        .filter((p) => p.type === 'text')
        .map((p) => p.text ?? '')
        .join('');
}

// Strip to lowercase letters/numbers so a DOM<->IDB text compare survives
// markdown re-rendering: the DOM has markdown rendered away (`**x**` -> `x`)
// while the IDB holds the raw source, but the syntax chars are non-alnum on
// both sides and drop out here, as do whitespace and punctuation. It does NOT
// reconcile link URLs (raw-only) or the Sources/citation UI (DOM-only), so
// turns carrying those compare with mode:'contains' instead of equality.
function normalizeText(s: string): string {
    return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

// Read the extension's chat IDB straight through the SW. The page can't see it
// (different origin), so this is the source-of-truth check that a row persisted.
function readExtDb(
    sw: Worker
): Promise<{ metas: StoredMeta[]; messages: StoredMsg[] }> {
    return sw.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            // No version -> open at the current version, never trigger an upgrade.
            const req = indexedDB.open('courierai');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        const getAll = (store: string) =>
            new Promise<unknown[]>((resolve, reject) => {
                const req = db
                    .transaction(store, 'readonly')
                    .objectStore(store)
                    .getAll();
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        const [metas, messages] = await Promise.all([
            getAll('chat_meta'),
            getAll('chat_messages'),
        ]);
        db.close();
        return { metas, messages };
    }) as Promise<{ metas: StoredMeta[]; messages: StoredMsg[] }>;
}

// Thin page object so specs read like the test plan. Locators are accessibility-
// first (role + name); message rows fall back to the existing data-msg-* attrs.
export class CourierAI {
    constructor(
        public readonly page: Page,
        private readonly sw: Worker
    ) {}

    async goto(): Promise<void> {
        await this.page.goto(`${BASE_URL}/app/`);
        await expect(this.composer()).toBeVisible();
    }

    composer() {
        return this.page.getByRole('textbox', { name: 'Message' });
    }
    sendButton() {
        return this.page.getByRole('button', { name: 'Send message' });
    }
    stopButton() {
        return this.page.getByRole('button', { name: 'Stop' });
    }
    newChatButton() {
        return this.page.getByRole('button', { name: 'New Chat' });
    }
    assistantMessages() {
        return this.page.locator('[data-msg-role="assistant"]');
    }
    userMessages() {
        return this.page.locator('[data-msg-role="user"]');
    }
    contextUsage() {
        return this.page.getByTestId('context-window-usage');
    }
    maxTokensBadge() {
        return this.page.getByRole('spinbutton', { name: 'Max output tokens' });
    }
    providerSelect() {
        return this.page.getByLabel('Provider');
    }
    // ModelPicker's trigger is the only listbox-popup button on the page.
    modelTrigger() {
        return this.page.locator('button[aria-haspopup="listbox"]');
    }
    // Both the app-wide errorStore banner and the per-chat stream error render
    // as role="alert" - either satisfies "errors must be loud".
    appError() {
        return this.page.getByRole('alert');
    }

    modelSearch() {
        return this.page.getByPlaceholder('Search models...');
    }
    // Per-chat tool toggles in ModelConfig. exact:true so they don't also match
    // the "Enable ..." master switches in Settings.
    webSearchToggle() {
        return this.page.getByRole('switch', {
            name: 'Web Search',
            exact: true,
        });
    }
    webFetchToggle() {
        return this.page.getByRole('switch', {
            name: 'Web Fetch',
            exact: true,
        });
    }
    codeExecToggle() {
        return this.page.getByRole('switch', {
            name: 'Code Execution',
            exact: true,
        });
    }
    settingsButton() {
        return this.page.getByRole('button', { name: 'Settings' });
    }
    settingsDialog() {
        return this.page.getByRole('dialog', { name: 'Settings' });
    }

    async setProvider(name: string): Promise<void> {
        await this.providerSelect().selectOption({ label: name });
    }

    async setModel(name: string): Promise<void> {
        await this.modelTrigger().click();
        await this.page.getByRole('option', { name }).click();
    }

    // Select a model by its stable id (data-model-id) rather than display name,
    // so OpenRouter's slug-style ids (e.g. '~anthropic/claude-haiku-latest')
    // and first-party ids both work. The picker only shows a search box past 50
    // models (OpenRouter), so fill it when present to bring the row into view.
    async setModelById(id: string): Promise<void> {
        await this.modelTrigger().click();
        const search = this.modelSearch();
        if (await search.isVisible().catch(() => false)) await search.fill(id);
        await this.page.locator(`[data-model-id="${id}"]`).click();
    }

    // OpenRouter's catalog hydrates async from the ext on load; the picker
    // trigger stays disabled until models arrive.
    async waitForOpenRouterCatalog(): Promise<void> {
        await expect(this.modelTrigger()).toBeEnabled({
            timeout: QUICK_TIMEOUT,
        });
    }

    // Drag the Thinking slider to None (its min). Selecting a thinking model
    // sets the level to that model's default (often non-zero), so specs that
    // need text to stream immediately (e.g. the stop-mid-stream flow) turn it
    // off first.
    async setThinkingNone(): Promise<void> {
        await this.page.getByRole('slider', { name: 'Thinking' }).press('Home');
    }

    async setChatWebSearch(on: boolean): Promise<void> {
        await this.setToggle(this.webSearchToggle(), on);
    }
    async setChatWebFetch(on: boolean): Promise<void> {
        await this.setToggle(this.webFetchToggle(), on);
    }
    async setChatCodeExecution(on: boolean): Promise<void> {
        await this.setToggle(this.codeExecToggle(), on);
    }

    private async setToggle(toggle: Locator, on: boolean): Promise<void> {
        await expect(toggle).toBeVisible();
        if ((await toggle.getAttribute('aria-checked')) !== String(on))
            await toggle.click();
    }

    // Temperature badge is a contenteditable spinbutton (same pattern as max
    // tokens); the model clamps to its temperatureMax on blur.
    async setTemperature(value: number): Promise<void> {
        const badge = this.page.getByRole('spinbutton', {
            name: 'Temperature',
        });
        await badge.click();
        await this.page.keyboard.press('ControlOrMeta+a');
        await this.page.keyboard.type(String(value));
        await this.page.keyboard.press('Enter');
    }

    async setSystemPrompt(text: string): Promise<void> {
        await this.page.getByRole('button', { name: 'System Prompt' }).click();
        await this.page
            .getByPlaceholder(
                'Give the model a persona, instructions, or context...'
            )
            .fill(text);
    }

    // Edit the last assistant bubble's text in place (hover -> Edit -> Save).
    // editMessage keeps non-text parts, so source-url citations survive the
    // edit - which is what the §4 re-injection check relies on.
    async editAssistant(newText: string): Promise<void> {
        const msg = this.assistantMessages().last();
        await msg.hover();
        await msg.getByRole('button', { name: 'Edit' }).click();
        const editor = msg.getByRole('textbox');
        await editor.fill(newText);
        await msg.getByRole('button', { name: 'Save' }).click();
    }

    // Expand the Code expando on the last assistant message (the rendered
    // code_execution tool call: code body + stdout/stderr). Used so --ui / trace
    // snapshots capture it; the spec asserts the underlying persisted tool part.
    async expandCode(): Promise<void> {
        await this.assistantMessages()
            .last()
            .getByRole('button', { name: 'Code' })
            .click();
    }

    // Expand the Sources expando on the last assistant message and return the
    // raw href attributes (the DOM-truth URLs the model actually searched).
    async assistantSourceHrefs(): Promise<string[]> {
        const msg = this.assistantMessages().last();
        await msg.getByRole('button', { name: 'Sources' }).click();
        const links = msg.locator('ol a');
        await expect(links.first()).toBeVisible();
        return links.evaluateAll((els) =>
            els.map((e) => e.getAttribute('href') ?? '')
        );
    }

    async openSettings(): Promise<void> {
        await this.settingsButton().click();
        await expect(this.settingsDialog()).toBeVisible();
    }
    settingsTab(name: string) {
        return this.settingsDialog().getByRole('button', { name });
    }
    async closeSettings(): Promise<void> {
        // The popover has no close button; clicking its backdrop closes it. The
        // dialog is centered, so a corner click lands on the backdrop.
        await this.page.mouse.click(5, 5);
        await expect(this.settingsDialog()).toBeHidden();
    }

    // Fill + send without waiting for a reply. Use for error paths, where the
    // assistant placeholder is removed when the error arrives (so `send`'s
    // wait-for-bubble would race).
    async compose(text: string): Promise<void> {
        await this.composer().fill(text);
        await this.sendButton().click();
    }

    async send(
        text: string,
        { turnTimeout = QUICK_TIMEOUT }: { turnTimeout?: number } = {}
    ): Promise<void> {
        const before = await this.assistantMessages().count();
        await this.compose(text);
        // Placeholder appears immediately at stream start - always quick, even
        // for tool-call turns (the tool runs after the placeholder is shown).
        await expect(this.assistantMessages()).toHaveCount(before + 1, {
            timeout: QUICK_TIMEOUT,
        });
        await this.waitForTurn(turnTimeout);
    }

    // Streaming is done when Stop reverts to Send. smoothTextMode is seeded to
    // 'raw', so there's no post-stream drain animation to wait on. `timeout`
    // bounds the whole turn: default for plain chat, TOOL_TURN_TIMEOUT for the
    // longer web-search round trip.
    async waitForTurn(timeout = QUICK_TIMEOUT): Promise<void> {
        await expect(this.stopButton()).toBeHidden({ timeout });
        await expect
            .poll(async () => (await this.lastAssistantText()).length, {
                timeout: QUICK_TIMEOUT,
            })
            .toBeGreaterThan(0);
    }

    async lastAssistantText(): Promise<string> {
        // Scope to the rendered markdown body (.prose) so the Thinking expando,
        // Sources list, and citation chips - each rendered as its own UI and
        // excluded from the persisted text parts - don't leak into the
        // round-trip text compare.
        return (
            await this.assistantMessages().last().locator('.prose').innerText()
        ).trim();
    }

    // The badge is a contenteditable spinbutton, so type rather than fill.
    async setMaxTokens(value: number): Promise<void> {
        const badge = this.maxTokensBadge();
        await badge.click();
        await this.page.keyboard.press('ControlOrMeta+a');
        await this.page.keyboard.type(String(value));
        await this.page.keyboard.press('Enter');
        await expect(badge).toHaveText(String(value));
    }

    readDb(): Promise<{ metas: StoredMeta[]; messages: StoredMsg[] }> {
        return readExtDb(this.sw);
    }

    // Stored messages of `role` for a chat (default: the first/only chat), in
    // chat order. getAll() returns key order (by uuid), so sort by createdAt
    // then id to match the ext's INDEX_CHAT_ORDER - `.at(-1)` is then the
    // latest turn.
    private async chatMessages(
        role: 'user' | 'assistant',
        chatId?: string
    ): Promise<StoredMsg[]> {
        const { metas, messages } = await this.readDb();
        const id = chatId ?? metas[0]?.id;
        return messages
            .filter((m) => m.chatId === id && m.message.role === role)
            .sort(
                (a, b) =>
                    (a.message.metadata?.createdAt ?? 0) -
                        (b.message.metadata?.createdAt ?? 0) ||
                    (a.message.id < b.message.id ? -1 : 1)
            );
    }

    // Persisted text per message of `role`, in chat order. The IDB-truth
    // counterpart to the DOM message locators, for round-trip checks.
    async persistedTexts(
        role: 'user' | 'assistant',
        chatId?: string
    ): Promise<string[]> {
        return (await this.chatMessages(role, chatId)).map(storedMessageText);
    }

    // source-url hrefs persisted on the latest assistant message - the IDB
    // truth behind the rendered Sources list.
    async persistedSourceUrls(chatId?: string): Promise<string[]> {
        const last = (await this.chatMessages('assistant', chatId)).at(-1);
        if (!last) return [];
        return last.message.parts
            .filter((p) => p.type === 'source-url')
            .map((p) => p.url ?? '');
    }

    // source-url titles persisted on the latest assistant message. Google cites
    // opaque grounding-redirect URLs and carries the readable host here in the
    // title, so the §4 recall check matches on title OR url.
    async persistedSourceTitles(chatId?: string): Promise<string[]> {
        const last = (await this.chatMessages('assistant', chatId)).at(-1);
        if (!last) return [];
        return last.message.parts
            .filter((p) => p.type === 'source-url')
            .map((p) => p.title ?? '');
    }

    // Names of `tool` parts persisted on the latest assistant message - the
    // IDB-truth that a server tool (web_search / web_fetch / code_execution)
    // actually fired. Used by the code-exec spec. Providers disagree on whether
    // web_fetch emits a tool part (Anthropic does; Google/OpenAI/OpenRouter
    // surface the fetch only as a Sources entry), so the web-fetch spec asserts
    // on the Sources expando instead of this.
    async persistedToolNames(chatId?: string): Promise<string[]> {
        const last = (await this.chatMessages('assistant', chatId)).at(-1);
        if (!last) return [];
        return last.message.parts
            .filter((p) => p.type === 'tool')
            .map((p) => p.name ?? '');
    }

    // Assert the latest assistant turn closed the full UI -> ext -> provider ->
    // ext -> UI round trip: it's both rendered (DOM) and persisted (ext IDB).
    // The IDB read is polled because the ext writes the assistant row at
    // end-of-turn, which can land just after the web flips Stop -> Send.
    //
    // mode 'equal' (default): normalized DOM text === normalized persisted
    // text - the strict check for plain-text replies. mode 'contains': only
    // require the persisted row to be non-empty; pair with `needle` for turns
    // where DOM and IDB differ by construction (web search adds link URLs / a
    // Sources expando the persisted text parts lack). `needle`, when given,
    // must appear in the DOM - proving not just *a* round trip but the *right*
    // content.
    async expectAssistantRoundTrip(
        needle?: string | RegExp,
        { mode = 'equal' }: { mode?: 'equal' | 'contains' } = {}
    ): Promise<void> {
        const dom = await this.lastAssistantText();
        if (needle === undefined) {
            expect(dom.length).toBeGreaterThan(0);
        } else if (typeof needle === 'string') {
            expect(dom).toContain(needle);
        } else {
            expect(dom).toMatch(needle);
        }

        const lastPersisted = async () =>
            (await this.persistedTexts('assistant')).at(-1) ?? '';

        if (mode === 'equal') {
            const target = normalizeText(dom);
            await expect
                .poll(async () => normalizeText(await lastPersisted()))
                .toBe(target);
        } else {
            await expect
                .poll(async () => (await lastPersisted()).length)
                .toBeGreaterThan(0);
        }
    }
}

interface CourierAIOptions {
    // Set false in a spec (`test.use({ seedApiKeys: false })`) to seed no API
    // keys, exercising the extension's "No API key saved" error path.
    seedApiKeys: boolean;
    // Set true in a spec (`test.use({ seedWebSearchEnabled: true })` etc.) to
    // seed the matching Advanced master toggle on, so ModelConfig renders that
    // per-model tool control (all off by default).
    seedWebSearchEnabled: boolean;
    seedWebFetchEnabled: boolean;
    seedCodeExecEnabled: boolean;
}

interface CourierAIFixtures {
    context: BrowserContext;
    serviceWorker: Worker;
    courierai: CourierAI;
    consoleCapture: void;
}

export const test = base.extend<CourierAIOptions & CourierAIFixtures>({
    seedApiKeys: [true, { option: true }],
    seedWebSearchEnabled: [false, { option: true }],
    seedWebFetchEnabled: [false, { option: true }],
    seedCodeExecEnabled: [false, { option: true }],
    // eslint-disable-next-line no-empty-pattern
    context: async ({}, use) => {
        // '' = ephemeral profile, auto-removed on close. headed: MV3 extensions
        // don't load in old headless. Bundled Chromium (no `channel`): stable
        // Chrome (~137+) blocks the --load-extension flag we rely on, while
        // Playwright's Chromium still honors it.
        const context = await chromium.launchPersistentContext('', {
            headless: false,
            baseURL: BASE_URL,
            args: [
                `--disable-extensions-except=${EXT_PATH}`,
                `--load-extension=${EXT_PATH}`,
            ],
        });
        await use(context);
        await context.close();
    },
    // Reuse the blank tab the persistent context opens with, instead of adding
    // a second one.
    page: async ({ context }, use) => {
        const page = context.pages()[0] ?? (await context.newPage());
        await use(page);
    },
    serviceWorker: async ({ context }, use) => {
        let [sw] = context.serviceWorkers();
        if (!sw) sw = await context.waitForEvent('serviceworker');
        await use(sw);
    },
    // Auto: collect page console warnings/errors (skips the app's chatty
    // console.log) + uncaught page errors. On teardown, if any, write them to a
    // focused per-test log (test-results/<test>/console-warnings.log) and echo
    // them to the terminal so failures are quick to scan without opening the
    // trace. (The extension service worker's console isn't exposed by
    // Playwright; web-side mirrors ext errors, so those still land here.)
    consoleCapture: [
        async ({ page }, use) => {
            const lines: string[] = [];
            page.on('console', (msg) => {
                const type = msg.type();
                if (type !== 'error' && type !== 'warning') return;
                const loc = msg.location();
                const where = loc.url ? `  (${loc.url}:${loc.lineNumber})` : '';
                lines.push(`[${type}] ${msg.text()}${where}`);
            });
            page.on('pageerror', (err) =>
                lines.push(`[pageerror] ${err.message}`)
            );
            await use();
            if (lines.length === 0) return;
            const info = test.info();
            const file = info.outputPath('console-warnings.log');
            const block = lines.join('\n') + '\n';
            appendFileSync(file, block);
            // Echo inline so page-side errors surface in the terminal under the
            // failing test; the file keeps a per-test copy for digging.
            process.stderr.write(
                `\nConsole warnings - ${info.title}:\n${block}`
            );
        },
        { auto: true },
    ],
    courierai: async (
        {
            page,
            serviceWorker,
            seedApiKeys,
            seedWebSearchEnabled,
            seedWebFetchEnabled,
            seedCodeExecEnabled,
        },
        use
    ) => {
        await seedExtension(serviceWorker, {
            withKeys: seedApiKeys,
            webSearch: seedWebSearchEnabled,
            webFetch: seedWebFetchEnabled,
            codeExec: seedCodeExecEnabled,
        });
        await use(new CourierAI(page, serviceWorker));
    },
});

export { expect };
// Re-exported so specs keep a single import surface (`./fixtures`); edit the
// picks in ./models.
export { PROVIDER_MODELS, type ProviderKey } from './models';
