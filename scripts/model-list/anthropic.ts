import { ANTHROPIC_API_VERSION } from '../../packages/shared/src/providers';
import { requireApiKey } from './env';
import { HttpError, httpJson, httpRequest } from './http';
import {
    type DerivedModel,
    type DerivedThinking,
    type ModelProbeResult,
    type SkippedModel,
    type ThinkingLevel,
    MODEL_PROBE_DELAY_MS,
    WEBPAGE_SCRAPE_DELAY_MS,
    idListWarning,
    pollWithDelay,
    printIdList,
    printModelRow,
    printPollingCacheSummary,
    printStep,
    probeFailureCode,
    scrapeMarkdownRaw,
    sortLevels,
} from './shared';
import {
    ANTHROPIC_OVERRIDES,
    ANTHROPIC_TOOLS_LATEST,
    applyOverride,
    staleOverrideIds,
} from './overrides';
import {
    type DocsCache,
    type DocsCacheSection,
    splitCached,
} from './docs-cache';
import { type ProbeCache, splitCachedProbes } from './probe-cache';

const ANTHROPIC_API = 'https://api.anthropic.com/v1';
const ANTHROPIC_MODELS_OVERVIEW_URL =
    'https://platform.claude.com/docs/en/models/overview.md';
const ANTHROPIC_MODEL_PAGE_BASE = 'https://platform.claude.com/docs/en/models/';
const ANTHROPIC_TOOL_REFERENCE_URL =
    'https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference.md';

interface AnthropicCapability {
    supported: boolean;
}

interface AnthropicServerTools extends AnthropicCapability {
    web_search: AnthropicCapability;
    code_execution: AnthropicCapability;
}

interface AnthropicCapabilities {
    citations: AnthropicCapability;
    code_execution: AnthropicCapability;
    effort: AnthropicCapability &
        Record<'low' | 'medium' | 'high' | 'max', AnthropicCapability> & {
            xhigh: AnthropicCapability | null;
        };
    image_input: AnthropicCapability;
    pdf_input: AnthropicCapability;
    server_tools: AnthropicServerTools;
    thinking: AnthropicCapability & {
        types: Record<
            'adaptive' | 'between_tools' | 'disabled' | 'enabled',
            AnthropicCapability
        >;
    };
}

interface AnthropicRawModel {
    id: string;
    display_name: string;
    created_at: string;
    max_input_tokens: number | null;
    max_tokens: number | null;
    capabilities: AnthropicCapabilities | null;
}

const ANTHROPIC_EFFORT_LEVELS = [
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
] as const satisfies readonly ThinkingLevel[];

const ANTHROPIC_CONTENT_CAPABILITIES = [
    'image_input',
    'pdf_input',
    'citations',
] as const;

interface AnthropicModelsPage {
    data?: AnthropicRawModel[];
    has_more?: boolean;
    last_id?: string | null;
}

function anthropicHeaders(): Record<string, string> {
    return {
        'x-api-key': requireApiKey('ANTHROPIC_API_KEY'),
        'anthropic-version': ANTHROPIC_API_VERSION,
    };
}

async function listAnthropicModels(): Promise<AnthropicRawModel[]> {
    const out: AnthropicRawModel[] = [];
    let afterId: string | undefined;
    do {
        const url = new URL(`${ANTHROPIC_API}/models`);
        url.searchParams.set('limit', '1000');
        if (afterId) url.searchParams.set('after_id', afterId);
        const page = await httpJson<AnthropicModelsPage>({
            url: url.toString(),
            label: 'Anthropic /v1/models',
            headers: anthropicHeaders(),
        });
        out.push(...(page.data ?? []));
        afterId = page.has_more && page.last_id ? page.last_id : undefined;
    } while (afterId);
    return out;
}

export async function fetchAnthropicModelIds(): Promise<string[]> {
    return (await listAnthropicModels()).map((m) => m.id).sort();
}

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

async function checkAnthropicToolVersions(): Promise<string[]> {
    console.log('scraping tool reference for current tool versions');
    try {
        const { status, text } = await httpRequest({
            url: ANTHROPIC_TOOL_REFERENCE_URL,
            label: 'Anthropic tool reference',
        });
        if (status !== 200) {
            return [`tool reference scrape failed (HTTP ${status})`];
        }
        const newest = parseAnthropicToolVersions(text);
        if (newest.size === 0) {
            return [
                'tool reference parsed to 0 tool versions - page layout may have changed',
            ];
        }
        const pins: Array<[string, string | boolean | undefined]> = [
            ['web_search', ANTHROPIC_TOOLS_LATEST.webSearch],
            ['web_fetch', ANTHROPIC_TOOLS_LATEST.webFetch],
            ['code_execution', ANTHROPIC_TOOLS_LATEST.codeExecution],
        ];
        const warnings: string[] = [];
        for (const [family, pinned] of pins) {
            const date = newest.get(family);
            if (!date || typeof pinned !== 'string') continue;
            const candidate = `${family}_${date}`;
            if (pinned !== candidate) {
                warnings.push(
                    `ANTHROPIC_TOOLS_LATEST pins ${pinned} but ${candidate} exists - review and bump`
                );
            }
        }
        return warnings;
    } catch (e) {
        return [`tool reference scrape failed: ${(e as Error).message}`];
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
        const { status, text } = await httpRequest({
            url: ANTHROPIC_MODELS_OVERVIEW_URL,
            label: 'Anthropic models overview',
        });
        if (status !== 200) {
            console.log(`WARN models overview scrape failed (HTTP ${status})`);
            return [];
        }
        const slugs = parseAnthropicModelSlugs(text);
        if (slugs.length === 0) {
            console.log(
                'WARN models overview linked 0 model pages - page layout may have changed'
            );
        }
        return slugs;
    } catch (e) {
        console.log(
            `WARN models overview scrape failed: ${(e as Error).message}`
        );
        return [];
    }
}

export function scrapeAnthropicModelPageRaw(slug: string) {
    return scrapeMarkdownRaw(`${ANTHROPIC_MODEL_PAGE_BASE}${slug}/overview.md`);
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

function addPageCutoff(
    cutoffs: Map<string, string>,
    slug: string,
    page: AnthropicModelPage
): boolean {
    if (!page.id || !page.knowledgeCutoff) {
        console.log(
            `WARN model page ${slug} parsed to id=${page.id} cutoff=${page.knowledgeCutoff} - page layout may have changed`
        );
        return false;
    }
    cutoffs.set(page.id, page.knowledgeCutoff);
    if (page.alias) cutoffs.set(page.alias, page.knowledgeCutoff);
    return true;
}

async function scrapeAnthropicModelPages(
    cache: DocsCache,
    pages: DocsCacheSection<AnthropicModelPage>
): Promise<Array<{ slug: string; page: AnthropicModelPage }>> {
    console.log('scraping Anthropic model pages for knowledge cutoffs');
    const slugs = await fetchAnthropicModelSlugs();
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
                        `WARN model page ${slug} scrape failed (HTTP ${res.status})`
                    );
                    return { slug, page: null };
                }
                const page = parseAnthropicModelPage(res.markdown);
                pages.set(slug, { code: String(res.status), value: page });
                return { slug, page };
            } catch (e) {
                console.log(
                    `WARN model page ${slug} scrape failed: ${(e as Error).message}`
                );
                return { slug, page: null };
            }
        }
    );
    await cache.save();

    const scraped: Array<{ slug: string; page: AnthropicModelPage }> = [];
    for (const { slug, page } of fresh) {
        if (page) scraped.push({ slug, page });
    }
    return scraped;
}

async function applyAnthropicCutoffs(
    models: DerivedModel[],
    cache: DocsCache
): Promise<void> {
    const pages = cache.section<AnthropicModelPage>(
        'anthropic',
        (page) => !!page.id && !!page.knowledgeCutoff
    );
    const cutoffs = new Map<string, string>();
    const { hits } = splitCached(pages.keys(), pages, (slug) => slug);
    for (const { item, parsed } of hits) addPageCutoff(cutoffs, item, parsed);

    const uncached = models
        .filter((m) => !m.knowledgeCutoff && !cutoffs.has(m.id))
        .map((m) => m.id);
    printIdList(
        `${uncached.length} Anthropic model(s) without a cached knowledge cutoff:`,
        uncached
    );
    if (uncached.length === 0) {
        console.log('all Anthropic knowledge cutoffs cached - skipping docs');
    } else {
        for (const { slug, page } of await scrapeAnthropicModelPages(
            cache,
            pages
        )) {
            if (addPageCutoff(cutoffs, slug, page)) {
                console.log(
                    `scraped ${slug}: ${page.id} -> ${page.knowledgeCutoff}`
                );
            }
        }
    }

    for (const m of models) {
        if (m.knowledgeCutoff) continue;
        const cutoff = cutoffs.get(m.id);
        if (cutoff) m.knowledgeCutoff = cutoff;
    }
}

export interface AnthropicPipelineResult {
    models: DerivedModel[];
    dead: string[];
    skipped: SkippedModel[];
    toolVersionWarnings: string[];
    unpinnedWithoutToolCalling: string[];
    unsupportedContent: string[];
}

export async function pipelineAnthropic(
    docsCache: DocsCache,
    probeCache: ProbeCache
): Promise<AnthropicPipelineResult> {
    console.log('starting Anthropic polling');
    const toolVersionWarnings = await checkAnthropicToolVersions();
    for (const w of toolVersionWarnings) console.log(`WARN ${w}`);

    const listed = (await listAnthropicModels()).map((raw) => {
        const model = deriveAnthropic(raw);
        const override = ANTHROPIC_OVERRIDES[raw.id];
        if (override) applyOverride(model, override);
        if (raw.capabilities) {
            restrictToServerTools(model, raw.capabilities.server_tools);
        }
        return { raw, model, toolsPinned: !!override?.tools };
    });
    const out = listed.map(({ model }) => model);
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
            const probe = await probeAnthropicModel(m.id);
            probeSection.set(m.id, probe);
            console.log(`tested ${m.id}, ${probe.code}`);
            return { model: m, probe };
        }
    );
    await probeCache.save();

    const probesById = new Map<string, ModelProbeResult>();
    for (const { item, probe } of hits) probesById.set(item.id, probe);
    for (const { model, probe } of fresh) probesById.set(model.id, probe);

    const kept: typeof listed = [];
    const dead: string[] = [];
    const skipped: SkippedModel[] = [];
    for (const entry of listed) {
        const { raw, model } = entry;
        const probe = probesById.get(model.id);
        if (!probe) throw new Error(`Missing Anthropic probe for ${model.id}`);
        if (probe.status === 'dead') {
            dead.push(model.id);
            skipped.push({
                id: raw.id,
                reason: `runtime probe ${probe.code} (not available)`,
            });
        } else kept.push(entry);
    }
    printIdList(
        `${dead.length} Anthropic model(s) failed runtime probe - skipped:`,
        dead
    );

    const unpinnedWithoutToolCalling = kept
        .filter(
            ({ raw, toolsPinned }) =>
                raw.capabilities &&
                !raw.capabilities.code_execution.supported &&
                !toolsPinned
        )
        .map(({ model }) => model.id);
    const unsupportedContent = kept.flatMap(({ raw, model }) => {
        const unsupported = raw.capabilities
            ? unsupportedContentCapabilities(raw.capabilities)
            : [];
        return unsupported.length > 0
            ? [`${model.id} (${unsupported.join(', ')})`]
            : [];
    });
    return {
        models: kept.map(({ model }) => model),
        dead,
        skipped,
        toolVersionWarnings,
        unpinnedWithoutToolCalling,
        unsupportedContent,
    };
}

async function probeAnthropicModel(id: string): Promise<ModelProbeResult> {
    try {
        await httpJson({
            url: `${ANTHROPIC_API}/messages`,
            label: `Anthropic probe ${id}`,
            method: 'POST',
            headers: anthropicHeaders(),
            body: {
                model: id,
                max_tokens: 1,
                messages: [{ role: 'user', content: 'a' }],
            },
        });
        return { status: 'ok', code: '200' };
    } catch (e) {
        const code = probeFailureCode(e);
        if (
            e instanceof HttpError &&
            (e.status === 404 || /not_found_error/i.test(e.body))
        ) {
            return { status: 'dead', code };
        }
        return { status: 'ok', code };
    }
}

function unsupportedContentCapabilities(cap: AnthropicCapabilities): string[] {
    return ANTHROPIC_CONTENT_CAPABILITIES.filter((key) => !cap[key].supported);
}

function restrictToServerTools(
    model: DerivedModel,
    serverTools: AnthropicServerTools
): void {
    if (!model.tools) return;
    const { webSearch, codeExecution, ...rest } = model.tools;
    model.tools = {
        ...rest,
        ...(serverTools.web_search.supported ? { webSearch } : {}),
        ...(serverTools.code_execution.supported ? { codeExecution } : {}),
    };
}

function deriveAnthropicThinking(
    cap: AnthropicCapabilities
): DerivedThinking | undefined {
    if (!cap.thinking.supported) return undefined;
    const types = cap.thinking.types;
    const efforts: ThinkingLevel[] = ANTHROPIC_EFFORT_LEVELS.filter(
        (level) => cap.effort[level]?.supported
    );
    if (efforts.length === 0) {
        return types.enabled.supported
            ? {
                  levels: ['none', 'low', 'medium', 'high'],
                  defaultLevel: 'none',
              }
            : undefined;
    }

    const offLevels: ThinkingLevel[] = types.disabled.supported
        ? ['none']
        : types.between_tools.supported
          ? ['minimal']
          : [];
    let adaptive: 'optional' | 'required' | undefined;
    if (types.adaptive.supported) {
        adaptive = types.enabled.supported ? 'optional' : 'required';
    }
    const defaultLevel: ThinkingLevel = efforts.includes('high')
        ? 'high'
        : efforts.includes('medium')
          ? 'medium'
          : efforts[0];
    return {
        levels: sortLevels([...offLevels, ...efforts]),
        defaultLevel,
        adaptive,
    };
}

function deriveAnthropic(m: AnthropicRawModel): DerivedModel {
    const notes: string[] = [];
    const cap = m.capabilities;
    if (!cap) notes.push('capabilities missing');
    else {
        const unsupported = unsupportedContentCapabilities(cap);
        if (unsupported.length > 0) {
            notes.push(`unsupported: ${unsupported.join(', ')}`);
        }
    }
    if (m.max_input_tokens == null) notes.push('max_input_tokens missing');
    if (m.max_tokens == null) notes.push('max_tokens missing');

    return {
        id: m.id,
        name: m.display_name,
        contextWindow: m.max_input_tokens,
        maxOutputTokens: m.max_tokens,
        thinking: cap ? deriveAnthropicThinking(cap) : undefined,
        tools: ANTHROPIC_TOOLS_LATEST,
        created: Date.parse(m.created_at) / 1000,
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

export function anthropicWarnings(r: AnthropicPipelineResult): string[] {
    const missing = r.models.filter((m) => !m.knowledgeCutoff).map((m) => m.id);
    return [
        ...r.toolVersionWarnings,
        ...idListWarning(
            `${r.unpinnedWithoutToolCalling.length} model(s) lack programmatic tool calling but use ANTHROPIC_TOOLS_LATEST - pin supported tool versions in ANTHROPIC_OVERRIDES:`,
            r.unpinnedWithoutToolCalling
        ),
        ...idListWarning(
            `${r.unsupportedContent.length} model(s) report unsupported image/PDF/citations - the Anthropic file policy assumes support:`,
            r.unsupportedContent
        ),
        ...idListWarning(
            `${missing.length} model(s) missing knowledgeCutoff - add to ANTHROPIC_OVERRIDES if desired:`,
            missing
        ),
        ...idListWarning(
            `${r.dead.length} model(s) failed the runtime probe - not published:`,
            r.dead
        ),
        ...idListWarning(
            'stale ANTHROPIC_OVERRIDES entry/entries - model not in current list, consider removing:',
            staleOverrideIds(ANTHROPIC_OVERRIDES, r.models)
        ),
    ];
}

export async function modelTestAnthropic(model: string): Promise<void> {
    await printStep(`Anthropic GET /v1/models/${model}`, () =>
        httpJson({
            url: `${ANTHROPIC_API}/models/${encodeURIComponent(model)}`,
            label: 'Anthropic model',
            headers: anthropicHeaders(),
        })
    );
    await printStep(
        `Anthropic POST /v1/messages (${model}, max_tokens=1)`,
        () =>
            httpJson({
                url: `${ANTHROPIC_API}/messages`,
                label: 'Anthropic messages',
                method: 'POST',
                headers: anthropicHeaders(),
                body: {
                    model,
                    max_tokens: 1,
                    messages: [{ role: 'user', content: 'a' }],
                },
            })
    );
}
