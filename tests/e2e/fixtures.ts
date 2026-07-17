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
} from '../../packages/airmailai_ext/openrouter-models';
import {
    DEFAULT_MODEL,
    DEFAULT_PROVIDER,
    OPENROUTER_CACHE_MODELS,
} from './models';

const ROOT = path.resolve(__dirname, '../..');
const EXT_PATH = path.join(
    ROOT,
    'packages',
    'airmailai_ext',
    '.output',
    'chrome-mv3'
);
const LEGAL_DIR = path.join(
    ROOT,
    'packages',
    'airmailai_web',
    'static',
    'legal'
);
const BASE_URL = process.env.AIRMAILAI_BASE_URL ?? 'http://localhost:5173';

export const QUICK_TIMEOUT = 30_000;
export const TOOL_TURN_TIMEOUT = 120_000;

const PROVIDER_ENV: Record<string, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    google: 'GOOGLE_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
};

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

async function seedExtension(
    sw: Worker,
    {
        withKeys,
        webSearch,
        webFetch,
        codeExec,
        fileUploads,
    }: {
        withKeys: boolean;
        webSearch: boolean;
        webFetch: boolean;
        codeExec: boolean;
        fileUploads: boolean;
    }
): Promise<void> {
    const local: Record<string, unknown> = withKeys ? apiKeysFromEnv() : {};
    if (withKeys) {
        local[OPENROUTER_CACHE_KEY] = {
            version: OPENROUTER_CACHE_VERSION,
            models: OPENROUTER_CACHE_MODELS,
            fetchedAt: Date.now(),
        };
    }
    // *** Seeded settings must stay self-consistent with DEFAULT_MODEL, like a
    // real stored profile: the app's boot defaults come from the picker's
    // default model (Sonnet 5, thinking 'high'), and a bare modelId seed would
    // leave that thinking level active on Haiku.
    const settings: Record<string, unknown> = {
        legalAcceptedVersion: legalVersion(),
        smoothTextMode: 'raw',
        providerId: DEFAULT_PROVIDER,
        modelId: DEFAULT_MODEL,
        thinkingLevel: 'none',
        adaptiveThinking: false,
    };
    if (webSearch) settings.enableWebSearch = true;
    if (webFetch) settings.enableWebFetch = true;
    if (codeExec) settings.enableCodeExecution = true;
    if (fileUploads) settings.enableFileUploads = true;
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
            filename?: string;
        }[];
        metadata?: { createdAt?: number };
    };
}

function storedMessageText(msg: StoredMsg): string {
    return msg.message.parts
        .filter((p) => p.type === 'text')
        .map((p) => p.text ?? '')
        .join('');
}

function normalizeText(s: string): string {
    return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function readExtDb(
    sw: Worker
): Promise<{ metas: StoredMeta[]; messages: StoredMsg[] }> {
    return sw.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const req = indexedDB.open('airmailai');
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

export class AirmailAI {
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
    modelTrigger() {
        return this.page.locator('button[aria-haspopup="listbox"]');
    }
    appError() {
        return this.page.getByRole('alert');
    }

    modelSearch() {
        return this.page.getByPlaceholder('Search models...');
    }
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

    async setModelById(id: string): Promise<void> {
        await this.modelTrigger().click();
        const search = this.modelSearch();
        if (await search.isVisible().catch(() => false)) await search.fill(id);
        await this.page.locator(`[data-model-id="${id}"]`).click();
    }

    async waitForOpenRouterCatalog(): Promise<void> {
        await expect(this.modelTrigger()).toBeEnabled({
            timeout: QUICK_TIMEOUT,
        });
    }

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

    async editAssistant(newText: string): Promise<void> {
        const msg = this.assistantMessages().last();
        await msg.hover();
        await msg.getByRole('button', { name: 'Edit' }).click();
        const editor = msg.getByRole('textbox');
        await editor.fill(newText);
        await msg.getByRole('button', { name: 'Save', exact: true }).click();
    }

    async editUser(newText: string): Promise<void> {
        const msg = this.userMessages().last();
        await msg.hover();
        await msg.getByRole('button', { name: 'Edit' }).click();
        const editor = msg.getByRole('textbox');
        await editor.fill(newText);
        await msg.getByRole('button', { name: 'Save', exact: true }).click();
    }

    async expandCode(): Promise<void> {
        await this.assistantMessages()
            .last()
            .getByRole('button', { name: 'Code', exact: true })
            .click();
    }

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
        await this.page.mouse.click(5, 5);
        await expect(this.settingsDialog()).toBeHidden();
    }

    async attachFile(file: {
        name: string;
        mimeType: string;
        buffer: Buffer;
    }): Promise<void> {
        await this.page
            .getByRole('region', { name: 'Chat' })
            .locator('input[type="file"]')
            .setInputFiles(file);
        await expect(
            this.page.getByRole('button', { name: 'Remove attachment' })
        ).toBeVisible({ timeout: QUICK_TIMEOUT });
    }

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
        await expect(this.assistantMessages()).toHaveCount(before + 1, {
            timeout: QUICK_TIMEOUT,
        });
        await this.waitForTurn(turnTimeout);
    }

    async waitForTurn(timeout = QUICK_TIMEOUT): Promise<void> {
        await expect(this.stopButton()).toBeHidden({ timeout });
        await expect
            .poll(async () => (await this.lastAssistantText()).length, {
                timeout: QUICK_TIMEOUT,
            })
            .toBeGreaterThan(0);
    }

    async lastAssistantText(): Promise<string> {
        return (
            await this.assistantMessages().last().locator('.prose').innerText()
        ).trim();
    }

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

    async persistedTexts(
        role: 'user' | 'assistant',
        chatId?: string
    ): Promise<string[]> {
        return (await this.chatMessages(role, chatId)).map(storedMessageText);
    }

    async persistedSourceUrls(chatId?: string): Promise<string[]> {
        const last = (await this.chatMessages('assistant', chatId)).at(-1);
        if (!last) return [];
        return last.message.parts
            .filter((p) => p.type === 'source-url')
            .map((p) => p.url ?? '');
    }

    async persistedSourceTitles(chatId?: string): Promise<string[]> {
        const last = (await this.chatMessages('assistant', chatId)).at(-1);
        if (!last) return [];
        return last.message.parts
            .filter((p) => p.type === 'source-url')
            .map((p) => p.title ?? '');
    }

    async persistedFileNames(
        role: 'user' | 'assistant',
        chatId?: string
    ): Promise<string[]> {
        return (await this.chatMessages(role, chatId)).flatMap((m) =>
            m.message.parts
                .filter((p) => p.type === 'file')
                .map((p) => p.filename ?? '')
        );
    }

    async persistedToolNames(chatId?: string): Promise<string[]> {
        const last = (await this.chatMessages('assistant', chatId)).at(-1);
        if (!last) return [];
        return last.message.parts
            .filter((p) => p.type === 'tool')
            .map((p) => p.name ?? '');
    }

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

interface AirmailAIOptions {
    seedApiKeys: boolean;
    seedWebSearchEnabled: boolean;
    seedWebFetchEnabled: boolean;
    seedCodeExecEnabled: boolean;
    seedFileUploadsEnabled: boolean;
}

interface AirmailAIFixtures {
    context: BrowserContext;
    serviceWorker: Worker;
    airmailai: AirmailAI;
    consoleCapture: void;
}

export const test = base.extend<AirmailAIOptions & AirmailAIFixtures>({
    seedApiKeys: [true, { option: true }],
    seedWebSearchEnabled: [false, { option: true }],
    seedWebFetchEnabled: [false, { option: true }],
    seedCodeExecEnabled: [false, { option: true }],
    seedFileUploadsEnabled: [false, { option: true }],
    // eslint-disable-next-line no-empty-pattern
    context: async ({}, use) => {
        // *** '' = ephemeral profile, auto-removed on close. headed: MV3 extensions
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
    page: async ({ context }, use) => {
        const page = context.pages()[0] ?? (await context.newPage());
        await use(page);
    },
    serviceWorker: async ({ context }, use) => {
        let [sw] = context.serviceWorkers();
        if (!sw) sw = await context.waitForEvent('serviceworker');
        await use(sw);
    },
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
            process.stderr.write(
                `\nConsole warnings - ${info.title}:\n${block}`
            );
        },
        { auto: true },
    ],
    airmailai: async (
        {
            page,
            serviceWorker,
            seedApiKeys,
            seedWebSearchEnabled,
            seedWebFetchEnabled,
            seedCodeExecEnabled,
            seedFileUploadsEnabled,
        },
        use
    ) => {
        await seedExtension(serviceWorker, {
            withKeys: seedApiKeys,
            webSearch: seedWebSearchEnabled,
            webFetch: seedWebFetchEnabled,
            codeExec: seedCodeExecEnabled,
            fileUploads: seedFileUploadsEnabled,
        });
        await use(new AirmailAI(page, serviceWorker));
    },
});

export { expect };
export { PROVIDER_MODELS, type ProviderKey } from './models';
