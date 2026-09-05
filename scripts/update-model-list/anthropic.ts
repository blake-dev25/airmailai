import Anthropic from '@anthropic-ai/sdk';
import {
    type DerivedModel,
    type DerivedThinking,
    type ModelProbeResult,
    type ThinkingLevel,
    MODEL_PROBE_DELAY_MS,
    WEBPAGE_SCRAPE_DELAY_MS,
    pollWithDelay,
    printIdList,
    printModelRow,
    printPollingCacheSummary,
    probeErrorCode,
    sortLevels,
} from './shared';
import {
    ANTHROPIC_OVERRIDES,
    ANTHROPIC_TOOLS_LATEST,
    applyOverride,
    staleOverrideIds,
} from './overrides';
import { type DocsCache, splitCached } from './docs-cache';
import { type ProbeCache, splitCachedProbes } from './probe-cache';

const ANTHROPIC_MODELS_OVERVIEW_URL =
    'https://platform.claude.com/docs/en/models/overview.md';
const ANTHROPIC_MODEL_PAGE_BASE = 'https://platform.claude.com/docs/en/models/';
const ANTHROPIC_TOOL_REFERENCE_URL =
    'https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference.md';

export function parseAnthropicToolVersions(md: string): Map<string, string> {
    const newest = new Map<string, string>();
    for (const m of md.matchAll(
        /\b(web_search|web_fetch|code_execution)_(\d{8})\b/g
    )) {
        const [, family, date] = m;
        const current = newest.get(family);
        if (!current || date > current) newest.set(family, date);
    }
    return newest;
}

async function checkAnthropicToolVersions(): Promise<void> {
    console.log('scraping tool reference for current tool versions');
    try {
        const res = await fetch(ANTHROPIC_TOOL_REFERENCE_URL);
        if (!res.ok) {
            console.log(`⚠ tool reference scrape failed (HTTP ${res.status})`);
            return;
        }
        const newest = parseAnthropicToolVersions(await res.text());
        if (newest.size === 0) {
            console.log(
                '⚠ tool reference parsed to 0 tool versions - page layout may have changed'
            );
            return;
        }
        const pins: Array<[string, string | boolean | undefined]> = [
            ['web_search', ANTHROPIC_TOOLS_LATEST.webSearch],
            ['web_fetch', ANTHROPIC_TOOLS_LATEST.webFetch],
            ['code_execution', ANTHROPIC_TOOLS_LATEST.codeExecution],
        ];
        for (const [family, pinned] of pins) {
            const date = newest.get(family);
            if (!date || typeof pinned !== 'string') continue;
            const candidate = `${family}_${date}`;
            if (pinned !== candidate) {
                console.log(
                    `⚠ ANTHROPIC_TOOLS_LATEST pins ${pinned} but ${candidate} exists - review and bump`
                );
            }
        }
    } catch (e) {
        console.log(`⚠ tool reference scrape failed: ${(e as Error).message}`);
    }
}

// *** The docs pages are served as markdown directly - no turndown pass
export function parseAnthropicModelSlugs(overviewMd: string): string[] {
    const slugs = new Set<string>();
    for (const m of overviewMd.matchAll(
        /https:\/\/platform\.claude\.com\/docs\/en\/models\/([a-z0-9-]+)\/overview\b/g
    )) {
        slugs.add(m[1]);
    }
    return [...slugs];
}

async function fetchAnthropicModelSlugs(): Promise<string[]> {
    try {
        const res = await fetch(ANTHROPIC_MODELS_OVERVIEW_URL);
        if (!res.ok) {
            console.log(`⚠ models overview scrape failed (HTTP ${res.status})`);
            return [];
        }
        const slugs = parseAnthropicModelSlugs(await res.text());
        if (slugs.length === 0) {
            console.log(
                '⚠ models overview linked 0 model pages - page layout may have changed'
            );
        }
        return slugs;
    } catch (e) {
        console.log(`⚠ models overview scrape failed: ${(e as Error).message}`);
        return [];
    }
}

export async function scrapeAnthropicModelPageRaw(slug: string): Promise<{
    url: string;
    status: number;
    markdown: string | null;
}> {
    const url = `${ANTHROPIC_MODEL_PAGE_BASE}${slug}/overview.md`;
    const res = await fetch(url);
    return {
        url,
        status: res.status,
        markdown: res.ok ? await res.text() : null,
    };
}

export interface AnthropicModelPage {
    id?: string;
    alias?: string;
    knowledgeCutoff?: string;
}

export function parseAnthropicModelPage(md: string): AnthropicModelPage {
    const page: AnthropicModelPage = {};
    for (const line of md.split('\n')) {
        if (!/^\s*\|/.test(line)) continue;
        const cells = line.split('|').map((c) => c.trim());
        if (cells.length !== 4) continue;
        const label = cells[1].replace(/\[([^\]]+)\]\([^)]*\)/, '$1');
        const value = cells[2].replace(/`/g, '');
        if (label === 'Claude API') page.id = value;
        else if (label === 'Claude API alias') page.alias = value;
        else if (label === 'Reliable knowledge cutoff') {
            page.knowledgeCutoff = value.match(/[A-Z][a-z]{2} \d{4}/)?.[0];
        }
    }
    return page;
}

async function scrapeAnthropicCutoffs(
    cache: DocsCache
): Promise<Map<string, string>> {
    console.log('scraping Anthropic model pages for knowledge cutoffs');
    const cutoffs = new Map<string, string>();
    const slugs = await fetchAnthropicModelSlugs();
    const pages = cache.section<AnthropicModelPage>('anthropic', 'pages');
    const { hits, failures, misses } = splitCached(
        slugs,
        pages,
        (slug) => slug
    );
    console.log(`found ${slugs.length} model page(s)`);
    printPollingCacheSummary(
        'Anthropic docs polling',
        [...hits.map(() => '200'), ...failures.map((f) => f.code)],
        misses.length,
        WEBPAGE_SCRAPE_DELAY_MS
    );
    const fresh = await pollWithDelay(
        misses,
        WEBPAGE_SCRAPE_DELAY_MS,
        async (slug) => {
            try {
                const res = await scrapeAnthropicModelPageRaw(slug);
                console.log(`got ${slug} docs, ${res.status}`);
                if (!res.markdown) {
                    pages.set(slug, {
                        code: String(res.status),
                        value: null,
                    });
                    console.log(
                        `⚠ model page ${slug} scrape failed (HTTP ${res.status})`
                    );
                    return { slug, page: null };
                }
                const page = parseAnthropicModelPage(res.markdown);
                pages.set(slug, { code: String(res.status), value: page });
                return { slug, page };
            } catch (e) {
                console.log(
                    `⚠ model page ${slug} scrape failed: ${(e as Error).message}`
                );
                return { slug, page: null };
            }
        }
    );
    await cache.save();

    const pagesBySlug = new Map<string, AnthropicModelPage>();
    for (const { item, parsed } of hits) pagesBySlug.set(item, parsed);
    for (const { slug, page } of fresh) {
        if (page) pagesBySlug.set(slug, page);
    }
    for (const [slug, page] of pagesBySlug) {
        if (!page.id || !page.knowledgeCutoff) {
            console.log(
                `⚠ model page ${slug} parsed to id=${page.id} cutoff=${page.knowledgeCutoff} - page layout may have changed`
            );
            continue;
        }
        cutoffs.set(page.id, page.knowledgeCutoff);
        if (page.alias) cutoffs.set(page.alias, page.knowledgeCutoff);
        console.log(`scraped ${slug}: ${page.id} -> ${page.knowledgeCutoff}`);
    }
    return cutoffs;
}

async function applyAnthropicCutoffs(
    models: DerivedModel[],
    cache: DocsCache
): Promise<void> {
    const cutoffs = cache.section<string>('anthropic');
    const uncached = models
        .filter((m) => !m.knowledgeCutoff && cutoffs.get(m.id) === undefined)
        .map((m) => m.id);
    printIdList(
        `${uncached.length} Anthropic model(s) without a cached knowledge cutoff:`,
        uncached
    );
    const fresh =
        uncached.length > 0
            ? await scrapeAnthropicCutoffs(cache)
            : new Map<string, string>();
    if (uncached.length === 0) {
        console.log('all Anthropic knowledge cutoffs cached - skipping docs');
    }
    for (const [id, cutoff] of fresh) {
        cutoffs.set(id, { code: '200', value: cutoff });
    }
    if (fresh.size > 0) await cache.save();
    for (const m of models) {
        if (m.knowledgeCutoff) continue;
        const cutoff = fresh.get(m.id) ?? cutoffs.get(m.id)?.value;
        if (cutoff) m.knowledgeCutoff = cutoff;
    }
}

export async function fetchAnthropic(
    docsCache: DocsCache,
    probeCache: ProbeCache
): Promise<DerivedModel[]> {
    console.log('starting Anthropic polling');
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY missing from .env');
    const client = new Anthropic({ apiKey: key });

    await checkAnthropicToolVersions();
    const out: DerivedModel[] = [];
    for await (const m of client.models.list({ limit: 1000 })) {
        const d = deriveAnthropic(m);
        const o = ANTHROPIC_OVERRIDES[d.id];
        if (o) applyOverride(d, o);
        out.push(d);
    }
    await applyAnthropicCutoffs(out, docsCache);
    const probeSection = probeCache.section('anthropic');
    const { hits, misses } = splitCachedProbes(
        out,
        probeSection,
        (model) => model.id
    );
    printPollingCacheSummary(
        'Anthropic 404 polling',
        hits.map(({ probe }) => probe.code),
        misses.length,
        MODEL_PROBE_DELAY_MS
    );
    const fresh = await pollWithDelay(
        misses,
        MODEL_PROBE_DELAY_MS,
        async (m) => {
            const probe = await probeAnthropicModel(client, m.id);
            probeSection.set(m.id, probe);
            console.log(`tested ${m.id}, ${probe.code}`);
            return { model: m, probe };
        }
    );
    await probeCache.save();

    const probesById = new Map<string, ModelProbeResult>();
    for (const { item, probe } of hits) probesById.set(item.id, probe);
    for (const { model, probe } of fresh) probesById.set(model.id, probe);

    const kept: DerivedModel[] = [];
    const dead: string[] = [];
    for (const model of out) {
        const probe = probesById.get(model.id);
        if (!probe) throw new Error(`Missing Anthropic probe for ${model.id}`);
        if (probe.status === 'dead') dead.push(model.id);
        else kept.push(model);
    }
    printIdList(
        `${dead.length} Anthropic model(s) failed runtime probe - skipped:`,
        dead
    );
    return kept;
}

async function probeAnthropicModel(
    client: Anthropic,
    id: string
): Promise<ModelProbeResult> {
    try {
        await client.messages.create({
            model: id,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'a' }],
        });
        return { status: 'ok', code: '200' };
    } catch (e) {
        const msg = (e as Error).message ?? String(e);
        const code = probeErrorCode(e);
        if (code === '404' || /not_found_error|model:/i.test(msg)) {
            return { status: 'dead', code };
        }
        return { status: 'ok', code };
    }
}

function deriveAnthropic(m: Anthropic.ModelInfo): DerivedModel {
    const notes: string[] = [];
    const cap = m.capabilities;

    let thinking: DerivedThinking | undefined;
    if (cap?.thinking?.supported) {
        const effort = cap.effort;
        const efforts: ThinkingLevel[] = [];
        if (effort?.low?.supported) efforts.push('low');
        if (effort?.medium?.supported) efforts.push('medium');
        if (effort?.high?.supported) efforts.push('high');
        if (effort?.xhigh?.supported) efforts.push('xhigh');
        if (effort?.max?.supported) efforts.push('max');

        if (efforts.length > 0) {
            const levels: ThinkingLevel[] = sortLevels(['none', ...efforts]);

            const enabledSupported = cap.thinking.types?.enabled?.supported;
            const adaptiveSupported = cap.thinking.types?.adaptive?.supported;
            let adaptive: 'optional' | 'required' | undefined;
            if (adaptiveSupported && enabledSupported) adaptive = 'optional';
            else if (adaptiveSupported && !enabledSupported)
                adaptive = 'required';

            const defaultLevel: ThinkingLevel = levels.includes('high')
                ? 'high'
                : levels.includes('medium')
                  ? 'medium'
                  : (levels[1] ?? 'none');

            thinking = { levels, defaultLevel, adaptive };
        } else if (cap.thinking.types?.enabled?.supported) {
            thinking = {
                levels: ['none', 'low', 'medium', 'high'],
                defaultLevel: 'none',
            };
        }
    }

    if (m.max_input_tokens == null) notes.push('max_input_tokens missing');
    if (m.max_tokens == null) notes.push('max_tokens missing');

    const samplingParamsRemoved = thinking?.adaptive === 'required';

    return {
        id: m.id,
        name: m.display_name,
        contextWindow: m.max_input_tokens,
        maxOutputTokens: m.max_tokens,
        thinking,
        ...(samplingParamsRemoved
            ? {}
            : { temperatureMax: 1, defaultTemperature: 1 }),
        tools: ANTHROPIC_TOOLS_LATEST,
        notes,
    };
}

export function printAnthropicSummary(
    label: string,
    models: DerivedModel[]
): void {
    console.log(`\n=== ${label} - ${models.length} models ===`);
    for (const m of models) {
        printModelRow(m, {
            padWidth: 40,
            thinkingKind: 'anthropic',
            showNotes: true,
        });
    }
}

export function printAnthropicWarnings(models: DerivedModel[]): void {
    const missing = models.filter((m) => !m.knowledgeCutoff).map((m) => m.id);
    printIdList(
        `${missing.length} model(s) missing knowledgeCutoff - add to OVERRIDES if desired:`,
        missing
    );
    const stale = staleOverrideIds(ANTHROPIC_OVERRIDES, models);
    printIdList(
        `${stale.length} stale ANTHROPIC_OVERRIDES entry/entries - model not in current list, consider removing:`,
        stale
    );
}
