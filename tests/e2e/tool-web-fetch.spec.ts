import {
    expect,
    PROVIDER_MODELS,
    type ProviderKey,
    test,
    TOOL_TURN_TIMEOUT,
} from './fixtures';

// Web Fetch. One turn per provider: the model fetches a URL we name and answers
// from it. Unlike web search there's no stateless-replay round-trip. The fetched
// page's content isn't deterministic, so the proof is the fetched URL showing up
// as a Source on the reply (plus a non-empty reply). Providers differ on the
// tool wiring - Anthropic emits a web_fetch tool part, OpenAI folds fetch into
// web_search, Google/OpenRouter emit neither - but all four expose the fetched
// page as a source-url, so the Sources expando is the portable proof.
//
// Seed only the Web Fetch master toggle so ModelConfig renders the per-model Web
// Fetch control. For OpenAI (search + fetch fold into one server tool) seeding
// fetch alone keeps the standalone "Web Fetch" toggle rather than the linked one.
test.use({ seedWebFetchEnabled: true });

// The page the model is told to fetch; the proof is this URL appearing as a
// Source on the reply.
const FETCH_URL = 'https://www.formula1.com/en/racing/2026';

const PROVIDERS: ProviderKey[] = [
    'anthropic',
    'openai',
    'google',
    'openrouter',
];

for (const key of PROVIDERS) {
    const { label, tools } = PROVIDER_MODELS[key];

    test(`${label} web fetch invokes the tool and answers from the page`, async ({
        courierai,
    }) => {
        // A fetch turn makes an extra provider round trip (up to
        // TOOL_TURN_TIMEOUT), so it needs headroom past the default 60s per-test
        // cap and the 120s tool-turn ceiling.
        test.setTimeout(180_000);
        await courierai.goto();
        await courierai.setProvider(label);
        if (key === 'openrouter') await courierai.waitForOpenRouterCatalog();
        await courierai.setModelById(tools);
        await courierai.setChatWebFetch(true);

        // Same prompt as provider-test.ts DEFAULT_PROMPTS.web_fetch.
        await courierai.send(
            `Fetch ${FETCH_URL} and tell me when the next race is.`,
            { turnTimeout: TOOL_TURN_TIMEOUT }
        );

        // The reply rendered (DOM) and isn't empty.
        expect((await courierai.lastAssistantText()).length).toBeGreaterThan(0);

        // PASS = the page we asked for shows up as a Source on the reply, which
        // only happens if the server tool actually fetched it (the page content
        // itself isn't stable enough to assert on).
        const hrefs = await courierai.assistantSourceHrefs();
        expect(hrefs.some((h) => h.includes(FETCH_URL))).toBe(true);
    });
}
