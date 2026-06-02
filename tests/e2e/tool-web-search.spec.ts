import {
    expect,
    PROVIDER_MODELS,
    type ProviderKey,
    test,
    TOOL_TURN_TIMEOUT,
} from './fixtures';

// Web Search. ONE combined flow per provider: a web-search turn must render
// + persist citations, those cited sources must survive an in-place text edit,
// and a later turn (search off) must recall one of them - proving the sources
// were re-injected into context, not re-searched and not guessed. Each phase
// depends on the prior one (you can't check re-injection without first having
// searched), so they ride one round-trip chain with test.step() labels rather
// than splitting into micro-tests.
//
// Seed the Advanced master toggle on so ModelConfig renders the per-model Web
// Search control (it's off by default).
test.use({ seedWebSearchEnabled: true });

// Reduce a cited URL to host+path, lowercased, without scheme/query/fragment or
// a trailing slash - the leeway that lets a recalled URL match the source it
// came from despite provider decoration (e.g. OpenAI's `?utm_source=openai`
// breadcrumb) while still requiring the actual, non-guessable path.
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

    // OpenAI folds search + fetch into one server tool (searchFetchLinked), but
    // since only the Web Search master is seeded (not Web Fetch), ModelConfig
    // still renders the standalone "Web Search" toggle setChatWebSearch drives.
    test(`${label} web search cites sources and re-injects them after edit`, async ({
        courierai,
    }) => {
        // Chains a web-search turn (up to TOOL_TURN_TIMEOUT) plus follow-ups, so
        // it needs headroom past both the default 60s per-test cap and the 120s
        // tool-turn ceiling.
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

            // The sources the DOM listed are persisted on the assistant message
            // (source-url parts) in the ext IDB, not just rendered. Capture what
            // this turn actually cited so the edit check compares against it -
            // no provider-specific URL to hard-code (OpenAI appends tracking
            // params, Google cites opaque grounding-redirect URLs).
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
            // editMessage keeps non-text parts: the source-url parts this turn
            // cited survive the text edit, so they stay in history (and remain
            // available to re-inject on later turns).
            expect(await courierai.persistedSourceUrls()).toEqual(turn1Sources);
        });

        await test.step('disable search, then recall the URL from context', async () => {
            await courierai.setChatWebSearch(false);
            // Ask the model to ECHO a prior source verbatim, not "what URL did
            // you use" - the latter invites capable models to introspect, decide
            // the (edited) "I completed the search." text means they never really
            // searched, and refuse. A verbatim copy of a non-guessable slug can
            // only come from the re-injected sources, which is the proof we want.
            await courierai.send(
                'Great. Without searching again, please print one of the previously returned URLs verbatim.'
            );
            // PASS = the reply echoes one of the actual URLs this turn cited -
            // proving the sources were re-injected from history (search is off,
            // and the exact path isn't guessable).
            const reply = (await courierai.lastAssistantText()).toLowerCase();
            // Match the recalled URL against the cited source URLs (host+path)
            // OR their titles. Google cites opaque grounding-redirect URLs and
            // carries the readable host only in the title; on recall the model
            // echoes that host (or the redirect verbatim) rather than the bare
            // redirect path, so the title is the matchable signal there. For the
            // other providers the url key already matches a real cited URL.
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
