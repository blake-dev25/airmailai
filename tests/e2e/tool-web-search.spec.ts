import {
    expect,
    PROVIDER_MODELS,
    type ProviderKey,
    test,
    TOOL_TURN_TIMEOUT,
} from './fixtures';

test.use({ seedWebSearchEnabled: true });

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

    test(`${label} web search cites sources and re-injects them after edit`, async ({
        courierai,
    }) => {
        test.setTimeout(240_000);
        await courierai.goto();
        await courierai.setProvider(label);
        if (key === 'openrouter') await courierai.waitForOpenRouterCatalog();
        await courierai.setModelById(tools);
        await courierai.setChatWebSearch(true);

        let turn1Sources: string[] = [];
        let turn1Titles: string[] = [];

        await test.step('search runs and renders citations + sources', async () => {
            await courierai.send(
                'Search the web for a news article published this week and briefly tell me what it says.',
                { turnTimeout: TOOL_TURN_TIMEOUT }
            );
            const hrefs = await courierai.assistantSourceHrefs();
            expect(hrefs.length).toBeGreaterThan(0);
            expect(hrefs[0]).toMatch(/^https?:\/\//);

            await expect
                .poll(async () => courierai.persistedSourceUrls())
                .toEqual(expect.arrayContaining(hrefs));
            turn1Sources = await courierai.persistedSourceUrls();
            turn1Titles = await courierai.persistedSourceTitles();
        });

        await test.step('edit the response to strip visible URLs', async () => {
            await courierai.editAssistant('I completed the search.');
            expect(await courierai.lastAssistantText()).toContain(
                'I completed the search.'
            );
            expect(await courierai.persistedSourceUrls()).toEqual(turn1Sources);
        });

        await test.step('disable search, then recall the URL from context', async () => {
            await courierai.setChatWebSearch(false);
            await courierai.send(
                'Great. Without searching again, please print one of the previously returned URLs verbatim.'
            );
            const reply = (await courierai.lastAssistantText()).toLowerCase();
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
