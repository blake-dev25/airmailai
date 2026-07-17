import {
    expect,
    PROVIDER_MODELS,
    type ProviderKey,
    test,
    TOOL_TURN_TIMEOUT,
} from './fixtures';

test.use({ seedWebFetchEnabled: true });

const FETCH_URL = 'https://www.formula1.com/en/racing/2026';

function urlKey(url: string): string {
    try {
        const u = new URL(url);
        return (u.host + u.pathname)
            .replace(/^www\./, '')
            .replace(/\/+$/, '')
            .toLowerCase();
    } catch {
        return url.trim().toLowerCase();
    }
}

const PROVIDERS: ProviderKey[] = [
    'anthropic',
    'openai',
    'google',
    'openrouter',
];

for (const key of PROVIDERS) {
    const { label, tools } = PROVIDER_MODELS[key];

    test(`${label} web fetch cites the page and re-injects it after edit`, async ({
        airmailai,
    }) => {
        test.setTimeout(240_000);
        await airmailai.goto();
        await airmailai.setProvider(label);
        if (key === 'openrouter') await airmailai.waitForOpenRouterCatalog();
        await airmailai.setModelById(tools);
        await airmailai.setChatWebFetch(true);

        let turn1Sources: string[] = [];
        let turn1Titles: string[] = [];

        await test.step('fetch runs and cites the page as a source', async () => {
            await airmailai.send(
                `Fetch ${FETCH_URL} and tell me when the next race is.`,
                { turnTimeout: TOOL_TURN_TIMEOUT }
            );
            expect(
                (await airmailai.lastAssistantText()).length
            ).toBeGreaterThan(0);
            const hrefs = await airmailai.assistantSourceHrefs();
            expect(hrefs.some((h) => h.includes(FETCH_URL))).toBe(true);

            await expect
                .poll(async () => airmailai.persistedSourceUrls())
                .toEqual(expect.arrayContaining(hrefs));
            turn1Sources = await airmailai.persistedSourceUrls();
            turn1Titles = await airmailai.persistedSourceTitles();
        });

        await test.step('strip the URL from both the prompt and the response', async () => {
            await airmailai.editUser(
                "Fetch a page and don't tell me anything about it."
            );
            await airmailai.editAssistant('I fetched the page.');
            expect(await airmailai.lastAssistantText()).toContain(
                'I fetched the page.'
            );
            expect(await airmailai.persistedSourceUrls()).toEqual(turn1Sources);
        });

        await test.step('disable fetch, then recall the URL from context', async () => {
            await airmailai.setChatWebFetch(false);
            await airmailai.send(
                'Great. Without fetching again, please print the previously returned URL verbatim.'
            );
            const reply = (await airmailai.lastAssistantText()).toLowerCase();
            const keys = [
                ...turn1Sources.map(urlKey),
                ...turn1Titles
                    .map((t) => t.trim().toLowerCase())
                    .filter((t) => t.length > 0),
            ];
            expect(
                keys.some((k) => reply.includes(k)),
                `recalled reply ${JSON.stringify(reply)} should contain one of ${JSON.stringify(keys)}`
            ).toBe(true);
        });
    });
}
