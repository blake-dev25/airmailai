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
    const { label, tools, toolsName } = PROVIDER_MODELS[key];

    test(`${label} web search cites sources and re-injects them after edit`, async ({
        airmailai,
    }) => {
        test.setTimeout(240_000);
        await airmailai.goto();
        await airmailai.setProvider(label);
        if (key === 'openrouter') {
            await airmailai.waitForOpenRouterCatalog();
            await airmailai.setModelById(tools);
        }
        await expect(airmailai.modelTrigger()).toContainText(toolsName);
        await airmailai.setChatWebSearch(true);

        let turn1Sources: string[] = [];
        let turn1Titles: string[] = [];

        await test.step('search runs and renders citations + sources', async () => {
            await airmailai.send(
                'Search the web for a news article published this week and briefly tell me what it says.',
                { turnTimeout: TOOL_TURN_TIMEOUT }
            );
            const hrefs = await airmailai.assistantSourceHrefs();
            expect(hrefs.length).toBeGreaterThan(0);
            expect(hrefs[0]).toMatch(/^https?:\/\//);

            await expect
                .poll(async () => airmailai.persistedSourceUrls())
                .toEqual(expect.arrayContaining(hrefs));
            turn1Sources = await airmailai.persistedSourceUrls();
            turn1Titles = await airmailai.persistedSourceTitles();
        });

        await test.step('edit the response to strip visible URLs', async () => {
            await airmailai.editAssistant('I completed the search.');
            expect(await airmailai.lastAssistantText()).toContain(
                'I completed the search.'
            );
            expect(await airmailai.persistedSourceUrls()).toEqual(turn1Sources);
        });

        await test.step('disable search, then recall the URL from context', async () => {
            await airmailai.setChatWebSearch(false);
            await airmailai.send(
                'This is an API test. I have removed your output from your previous message, but kept the URLs. I also turned off Web Search functionality just for this turn. Please return one of the URLs verbatim.'
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
