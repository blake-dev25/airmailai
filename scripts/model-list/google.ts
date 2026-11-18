import { requireApiKey } from './env';
import { HttpError, errorMessage, httpJson, sleep } from './http';
import {
    type DerivedModel,
    type DerivedThinking,
    type ModelProbeResult,
    type OpenRouterIndex,
    type OpenRouterModelInfo,
    type SkippedModel,
    type ThinkingLevel,
    MODEL_PROBE_DELAY_MS,
    WEBPAGE_SCRAPE_DELAY_MS,
    fallbackReasoningThinking,
    findOpenRouter,
    formatKnowledgeCutoff,
    idListWarning,
    isThinkingLevel,
    pollWithDelay,
    printModelRow,
    printPollingCacheSummary,
    printStep,
    probeFailureCode,
    scrapeDocsRaw,
    scrapeMarkdownRaw,
    sortLevels,
    stripProviderName,
    supportsOpenRouterParam,
} from './shared';
import { GOOGLE_OVERRIDES, staleOverrideIds } from './overrides';
import { type DocsCache, splitCached } from './docs-cache';
import { type ProbeCache, splitCachedProbes } from './probe-cache';

const GOOGLE_API = 'https://generativelanguage.googleapis.com/v1beta';
const GOOGLE_DOCS = 'https://aistudio.google.com/docs';
const GOOGLE_THINKING_DOCS_URL = `${GOOGLE_DOCS}/thinking.md`;

interface GoogleRawModel {
    name: string;
    displayName?: string;
    description?: string;
    inputTokenLimit?: number;
    outputTokenLimit?: number;
    supportedGenerationMethods?: string[];
    temperature?: number;
    maxTemperature?: number;
    thinking?: boolean;
}

interface GoogleModelsPage {
    models?: GoogleRawModel[];
    nextPageToken?: string;
}

function googleHeaders(): Record<string, string> {
    return { 'x-goog-api-key': requireApiKey('GOOGLE_API_KEY') };
}

async function listGoogleModels(): Promise<GoogleRawModel[]> {
    const out: GoogleRawModel[] = [];
    let pageToken: string | undefined;
    do {
        const url = new URL(`${GOOGLE_API}/models`);
        url.searchParams.set('pageSize', '1000');
        if (pageToken) url.searchParams.set('pageToken', pageToken);
        const page = await httpJson<GoogleModelsPage>({
            url: url.toString(),
            label: 'Google /v1beta/models',
            headers: googleHeaders(),
        });
        out.push(...(page.models ?? []));
        pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
}

export async function fetchGoogleModelIds(): Promise<string[]> {
    return (await listGoogleModels()).map(googleModelId).sort();
}

async function probeGoogleModel(id: string): Promise<ModelProbeResult> {
    try {
        await httpJson({
            url: `${GOOGLE_API}/models/${encodeURIComponent(id)}:generateContent`,
            label: `Google probe ${id}`,
            method: 'POST',
            headers: googleHeaders(),
            body: {
                contents: [{ parts: [{ text: 'a' }] }],
                generationConfig: { maxOutputTokens: 1 },
            },
        });
        return { status: 'ok', code: '200' };
    } catch (e) {
        const code = probeFailureCode(e);
        if (e instanceof HttpError) {
            if (/no longer available to new users/i.test(e.body)) {
                return { status: 'grandfathered', code };
            }
            if (e.status === 404 || /NOT_FOUND/.test(e.body)) {
                return { status: 'dead', code };
            }
            if (e.status === 400 && /INVALID_ARGUMENT/.test(e.body)) {
                return {
                    status: 'unsupported',
                    code,
                    message: googleErrorMessage(e.body),
                };
            }
        }
        return { status: 'ok', code };
    }
}

function googleErrorMessage(body: string): string {
    return body.match(/"message":\s*"([^"]*)"/)?.[1] ?? body;
}

function googleModelId(m: GoogleRawModel): string {
    return m.name.replace(/^models\//, '');
}

function isGoogleChatCandidate(m: GoogleRawModel): boolean {
    return m.supportedGenerationMethods?.includes('generateContent') ?? false;
}

export async function scrapeGoogleDocsRaw(id: string) {
    return scrapeMarkdownRaw(`${GOOGLE_DOCS}/models/${id}.md`);
}

interface ScrapedGoogle {
    id: string;
    hasTextInput: boolean;
    hasTextOutput: boolean;
    hasMediaOutput: boolean;
    knowledgeCutoff: string | null;
    modelCardUrl: string | null;
}

const MONTH_ABBR: Record<string, string> = {
    January: 'Jan',
    February: 'Feb',
    March: 'Mar',
    April: 'Apr',
    May: 'May',
    June: 'Jun',
    July: 'Jul',
    August: 'Aug',
    September: 'Sep',
    October: 'Oct',
    November: 'Nov',
    December: 'Dec',
};

function abbreviateMonth(monthYear: string): string {
    return monthYear.replace(/^[A-Z][a-z]+/, (m) => MONTH_ABBR[m] ?? m);
}

function modalityRow(md: string, headerPattern: string): string {
    return (
        md.match(
            new RegExp(`\\*\\*${headerPattern}\\*\\*\\s+([^\\n]*)`)
        )?.[1] ?? ''
    );
}

export function parseGoogleDoc(id: string, md: string): ScrapedGoogle | null {
    const inputRow = modalityRow(md, 'Inputs?');
    const outputRow = modalityRow(md, 'Output');
    if (inputRow === '' && outputRow === '') return null;
    const hasTextInput = /\btext\b/i.test(inputRow);
    const hasTextOutput = /\btext\b/i.test(outputRow);
    const hasMediaOutput = /\b(?:audio|video)\b/i.test(outputRow);
    const koMatch = md.match(
        /Knowledge cutoff\s+\{% \/section %\}\s+\* ([A-Z][a-z]+ \d{4})/
    );
    const knowledgeCutoff = koMatch ? abbreviateMonth(koMatch[1]) : null;
    const modelCardUrl =
        md.match(
            /\[Model card\]\((https:\/\/deepmind\.google\/models\/model-cards\/[^)]+)\)/
        )?.[1] ?? null;
    return {
        id,
        hasTextInput,
        hasTextOutput,
        hasMediaOutput,
        knowledgeCutoff,
        modelCardUrl,
    };
}

export function parseGoogleModelCard(md: string): string | null {
    const m = md.match(
        /knowledge cutoff(?: date)? for .*? (?:is|was) ([A-Z][a-z]+ \d{4})/i
    );
    return m ? abbreviateMonth(m[1]) : null;
}

function pipeTableCells(line: string): string[] | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
    return trimmed
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim());
}

function parseGoogleThinkingRow(
    defaultThinking: string,
    supported: string
): DerivedThinking | null {
    const defMatch = defaultThinking.match(/^O(n|ff)(?: \(([a-z]+)\))?$/);
    if (!defMatch) return null;
    const rawLevels = supported.split(',').map((s) => s.trim());
    if (!rawLevels.every(isThinkingLevel)) return null;
    const levels = sortLevels(rawLevels);
    if (defMatch[1] === 'ff') {
        return {
            levels: sortLevels(['none', ...levels]),
            defaultLevel: 'none',
        };
    }
    const stated = defMatch[2];
    if (stated === undefined) {
        return {
            levels,
            defaultLevel: levels.includes('medium') ? 'medium' : levels[0],
        };
    }
    if (!isThinkingLevel(stated) || !levels.includes(stated)) return null;
    return { levels, defaultLevel: stated };
}

export interface GoogleThinkingRows {
    levels: Map<string, DerivedThinking>;
    malformedRows: string[];
}

export function parseGoogleThinkingLevels(md: string): GoogleThinkingRows {
    const parsed: GoogleThinkingRows = { levels: new Map(), malformedRows: [] };
    const rows = md.split('\n').map(pipeTableCells);
    const header = rows.findIndex(
        (cells) =>
            cells?.join('|') === 'Model|Default Thinking|Levels Supported'
    );
    if (header === -1) return parsed;
    for (const cells of rows.slice(header + 2)) {
        if (cells?.length !== 3) break;
        const [id, defaultThinking, supported] = cells;
        const thinking = /^[a-z0-9][a-z0-9.-]*$/.test(id)
            ? parseGoogleThinkingRow(defaultThinking, supported)
            : null;
        if (thinking) parsed.levels.set(id, thinking);
        else parsed.malformedRows.push(`| ${cells.join(' | ')} |`);
    }
    return parsed;
}

interface GoogleThinkingTable {
    levels: Map<string, DerivedThinking>;
    problem: string | null;
}

async function scrapeGoogleThinkingTable(): Promise<GoogleThinkingTable> {
    try {
        const { status, markdown } = await scrapeMarkdownRaw(
            GOOGLE_THINKING_DOCS_URL
        );
        if (markdown === null) {
            return {
                levels: new Map(),
                problem: `thinking docs scrape failed (HTTP ${status})`,
            };
        }
        const { levels, malformedRows } = parseGoogleThinkingLevels(markdown);
        if (malformedRows.length > 0) {
            return {
                levels,
                problem: idListWarning(
                    `thinking docs table has ${malformedRows.length} unparseable row(s) - skipped, page layout may have changed:`,
                    malformedRows
                )[0],
            };
        }
        return {
            levels,
            problem:
                levels.size === 0
                    ? 'thinking docs parsed to 0 rows - page layout may have changed'
                    : null,
        };
    } catch (e) {
        return {
            levels: new Map(),
            problem: `thinking docs scrape failed: ${errorMessage(e)}`,
        };
    }
}

async function fetchGoogleThinkingTable(): Promise<GoogleThinkingTable> {
    console.log('scraping Gemini thinking docs for levels');
    const table = await scrapeGoogleThinkingTable();
    console.log(
        table.problem === null
            ? `got ${table.levels.size} thinking level rows from docs`
            : `WARN ${table.problem}`
    );
    return table;
}

function googleAcceptsSamplingParams(id: string): boolean {
    return id.startsWith('gemini-2.5');
}

export function deriveGoogleTemperatureMax(
    id: string,
    apiMaxTemperature: number | undefined,
    info: OpenRouterModelInfo | undefined,
    overrideTemperatureMax: number | undefined
): number | undefined {
    if (overrideTemperatureMax !== undefined) return overrideTemperatureMax;
    if (!googleAcceptsSamplingParams(id)) return undefined;
    if (typeof apiMaxTemperature === 'number') return apiMaxTemperature;
    return supportsOpenRouterParam(info, 'temperature') ? 2 : undefined;
}

function googleThinkingFromOpenRouter(
    info: OpenRouterModelInfo | undefined
): DerivedThinking | undefined {
    const levels: ThinkingLevel[] = (info?.reasoningEfforts ?? []).filter(
        (l) => l !== 'none'
    );
    if (levels.length === 0) return undefined;
    const stated = info?.defaultReasoningEffort;
    return {
        levels,
        defaultLevel:
            stated && levels.includes(stated)
                ? stated
                : levels[Math.floor(levels.length / 2)],
        defaultGuessed: true,
    };
}

function deriveGoogle(
    m: GoogleRawModel,
    openrouter: OpenRouterIndex,
    scraped: ScrapedGoogle,
    thinkingTable: Map<string, DerivedThinking>
): DerivedModel {
    const id = googleModelId(m);
    const o = GOOGLE_OVERRIDES[id];
    const info = findOpenRouter(openrouter, 'google', id, o?.openRouterId);
    const notes: string[] = [];

    let thinking: DerivedThinking | undefined;
    const fromDocs = thinkingTable.get(id);
    const fromOpenRouter = googleThinkingFromOpenRouter(info);
    if (o?.thinking) {
        thinking = {
            levels: sortLevels(o.thinking.levels),
            defaultLevel: o.thinking.defaultLevel,
            ...(o.thinking.adaptive ? { adaptive: o.thinking.adaptive } : {}),
        };
    } else if (fromDocs) {
        thinking = fromDocs;
    } else if (fromOpenRouter) {
        thinking = fromOpenRouter;
    } else if (
        m.thinking === true ||
        supportsOpenRouterParam(info, 'reasoning')
    ) {
        thinking = fallbackReasoningThinking();
        notes.push('thinking supported but no levels - generic fallback used');
    }

    if (m.inputTokenLimit == null && info?.contextWindow == null) {
        notes.push('inputTokenLimit/contextWindow missing');
    }
    if (m.outputTokenLimit == null && info?.maxOutputTokens == null) {
        notes.push('outputTokenLimit/maxOutputTokens missing');
    }

    const temperatureMax = deriveGoogleTemperatureMax(
        id,
        m.maxTemperature,
        info,
        o?.temperatureMax
    );

    return {
        id,
        name:
            o?.name ??
            m.displayName ??
            (info ? stripProviderName(info.name, 'Google') : id),
        contextWindow:
            o?.contextWindow ??
            m.inputTokenLimit ??
            info?.contextWindow ??
            null,
        maxOutputTokens:
            o?.maxOutputTokens ??
            m.outputTokenLimit ??
            info?.maxOutputTokens ??
            null,
        knowledgeCutoff:
            o?.knowledgeCutoff ??
            scraped.knowledgeCutoff ??
            formatKnowledgeCutoff(info?.knowledgeCutoff),
        thinking,
        temperatureMax,
        defaultTemperature:
            temperatureMax !== undefined
                ? (o?.defaultTemperature ?? m.temperature ?? 1)
                : undefined,
        tools: o?.tools,
        created: info?.created,
        notes,
    };
}

export interface GooglePipelineResult {
    models: DerivedModel[];
    skipped: SkippedModel[];
    needsLevels: string[];
    guessedDefaultLevel: string[];
    missingCutoff: string[];
    grandfathered: string[];
    unparseableDocs: string[];
    thinkingDocsProblem: string | null;
}

type GoogleDocOutcome =
    | { kind: 'scraped'; m: GoogleRawModel; scraped: ScrapedGoogle }
    | { kind: 'missing'; m: GoogleRawModel; code: string }
    | { kind: 'unparseable'; m: GoogleRawModel };

export async function pipelineGoogle(
    openrouter: OpenRouterIndex,
    docsCache: DocsCache,
    probeCache: ProbeCache
): Promise<GooglePipelineResult> {
    console.log('starting Google polling');
    const raw = await listGoogleModels();

    const thinkingTable = await fetchGoogleThinkingTable();
    const skipped: SkippedModel[] = [];

    const candidates = raw.filter((m) => {
        const id = googleModelId(m);
        if (!isGoogleChatCandidate(m)) {
            skipped.push({
                id,
                reason: 'no generateContent in supportedGenerationMethods',
            });
            return false;
        }
        return true;
    });

    const pages = docsCache.section<ScrapedGoogle>('google');
    const { hits, failures, misses } = splitCached(
        candidates,
        pages,
        googleModelId
    );
    printPollingCacheSummary(
        'Google docs polling',
        [...hits.map(() => '200'), ...failures.map((f) => f.code)],
        misses.length,
        WEBPAGE_SCRAPE_DELAY_MS
    );
    const docOutcomes: GoogleDocOutcome[] = [
        ...hits.map(({ item, parsed }) => ({
            kind: 'scraped' as const,
            m: item,
            scraped: parsed,
        })),
        ...failures.map(({ item, code }) => ({
            kind: 'missing' as const,
            m: item,
            code,
        })),
        ...(await pollWithDelay(
            misses,
            WEBPAGE_SCRAPE_DELAY_MS,
            async (m): Promise<GoogleDocOutcome> => {
                const id = googleModelId(m);
                const { status, markdown } = await scrapeGoogleDocsRaw(id);
                console.log(`got ${id} docs, ${status}`);
                const code = String(status);
                if (markdown === null) {
                    pages.set(id, { code, value: null });
                    return { kind: 'missing', m, code };
                }
                const scraped = parseGoogleDoc(id, markdown);
                if (!scraped) {
                    console.log(
                        `WARN ${id} docs page has no Inputs/Output rows - not cached`
                    );
                    return { kind: 'unparseable', m };
                }
                let cardRetryable = false;
                if (!scraped.knowledgeCutoff && scraped.modelCardUrl) {
                    await sleep(WEBPAGE_SCRAPE_DELAY_MS);
                    const card = await scrapeDocsRaw(scraped.modelCardUrl);
                    console.log(`got ${id} model card, ${card.status}`);
                    if (card.markdown) {
                        scraped.knowledgeCutoff = parseGoogleModelCard(
                            card.markdown
                        );
                    } else if (card.status !== 404) {
                        cardRetryable = true;
                        console.log(
                            `WARN ${id} model card fetch failed (HTTP ${card.status}) - docs page not cached`
                        );
                    }
                }
                if (!cardRetryable) pages.set(id, { code, value: scraped });
                return { kind: 'scraped', m, scraped };
            }
        )),
    ];
    await docsCache.save();

    const unparseableDocs: string[] = [];
    const docSurvivors: DerivedModel[] = [];
    for (const outcome of docOutcomes) {
        const id = googleModelId(outcome.m);
        if (outcome.kind === 'missing') {
            skipped.push({
                id,
                reason: `${outcome.code} (no docs page - cached for 30 days, rerun with --retry-non-200 once it exists)`,
            });
            continue;
        }
        if (outcome.kind === 'unparseable') {
            skipped.push({ id, reason: 'docs page unparseable' });
            unparseableDocs.push(id);
            continue;
        }
        const { m, scraped } = outcome;
        if (!scraped.hasTextInput) {
            skipped.push({
                id,
                reason: 'inputs do not include Text (transcribe / etc.)',
            });
            continue;
        }
        if (!scraped.hasTextOutput) {
            skipped.push({
                id,
                reason: 'output does not include Text (TTS / image-only / etc.)',
            });
            continue;
        }
        if (scraped.hasMediaOutput) {
            skipped.push({
                id,
                reason: 'output includes audio or video (not handled)',
            });
            continue;
        }
        docSurvivors.push(
            deriveGoogle(m, openrouter, scraped, thinkingTable.levels)
        );
    }

    const probeSection = probeCache.section('google');
    const { hits: probeHits, misses: probeMisses } = splitCachedProbes(
        docSurvivors,
        probeSection,
        (model) => model.id
    );
    printPollingCacheSummary(
        'Google 404 polling',
        probeHits.map(({ probe }) => probe.code),
        probeMisses.length,
        MODEL_PROBE_DELAY_MS
    );
    const freshProbes = await pollWithDelay(
        probeMisses,
        MODEL_PROBE_DELAY_MS,
        async (m) => {
            const probe = await probeGoogleModel(m.id);
            probeSection.set(m.id, probe);
            console.log(`tested ${m.id}, ${probe.code}`);
            return { model: m, probe };
        }
    );
    await probeCache.save();

    const probesById = new Map<string, ModelProbeResult>();
    for (const { item, probe } of probeHits) {
        probesById.set(item.id, probe);
    }
    for (const { model, probe } of freshProbes) {
        probesById.set(model.id, probe);
    }

    const grandfathered: string[] = [];
    const models: DerivedModel[] = [];
    for (const model of docSurvivors) {
        const id = model.id;
        const probe = probesById.get(id);
        if (!probe) throw new Error(`Missing Google probe for ${id}`);
        if (probe.status === 'dead') {
            skipped.push({ id, reason: 'probe 404 (no longer available)' });
            continue;
        }
        if (probe.status === 'unsupported') {
            skipped.push({
                id,
                reason: `probe ${probe.code}: ${probe.message}`,
            });
            continue;
        }
        if (probe.status === 'grandfathered') grandfathered.push(id);
        models.push(model);
    }

    const needsLevels = models
        .filter((m) => m.notes.some((n) => n.includes('no levels')))
        .map((m) => m.id);
    const guessedDefaultLevel = models
        .filter((m) => m.thinking?.defaultGuessed)
        .map((m) => `${m.id} (${m.thinking?.defaultLevel})`);
    const missingCutoff = models
        .filter((m) => !m.knowledgeCutoff)
        .map((m) => m.id);
    return {
        models,
        skipped,
        needsLevels,
        guessedDefaultLevel,
        missingCutoff,
        grandfathered,
        unparseableDocs,
        thinkingDocsProblem: thinkingTable.problem,
    };
}

export function printGooglePipeline(r: GooglePipelineResult): void {
    console.log(
        `\n=== Google - ${r.models.length} chat models (${r.skipped.length} skipped) ===`
    );
    for (const m of r.models) {
        printModelRow(m, {
            padWidth: 50,
            thinkingKind: 'default',
            showNotes: true,
        });
    }
    if (r.skipped.length > 0) {
        console.log(`\n   ${r.skipped.length} skipped:`);
        for (const s of r.skipped) console.log(`   - ${s.id} - ${s.reason}`);
    }
}

export function googleWarnings(r: GooglePipelineResult): string[] {
    return [
        ...idListWarning(
            `${r.unparseableDocs.length} model(s) skipped - docs page has no Inputs/Output rows, page layout may have changed:`,
            r.unparseableDocs
        ),
        ...(r.thinkingDocsProblem === null ? [] : [r.thinkingDocsProblem]),
        ...idListWarning(
            `${r.grandfathered.length} grandfathered model(s) - kept (probe 404 with "to new users"):`,
            r.grandfathered
        ),
        ...idListWarning(
            `${r.needsLevels.length} thinking model(s) missing levels - add to GOOGLE_OVERRIDES if desired:`,
            r.needsLevels
        ),
        ...idListWarning(
            `${r.guessedDefaultLevel.length} model(s) use OpenRouter thinking levels with an unverified default - add to GOOGLE_OVERRIDES if desired:`,
            r.guessedDefaultLevel
        ),
        ...idListWarning(
            `${r.missingCutoff.length} model(s) missing knowledgeCutoff - add to GOOGLE_OVERRIDES if desired:`,
            r.missingCutoff
        ),
        ...idListWarning(
            'stale GOOGLE_OVERRIDES entry/entries - model not in current list, consider removing:',
            staleOverrideIds(GOOGLE_OVERRIDES, r.models)
        ),
    ];
}

export async function modelTestGoogle(model: string): Promise<void> {
    await printStep(`Google GET /v1beta/models/${model}`, () =>
        httpJson({
            url: `${GOOGLE_API}/models/${encodeURIComponent(model)}`,
            label: 'Google model',
            headers: googleHeaders(),
        })
    );
    await printStep(
        `Google POST :generateContent (${model}, maxOutputTokens=1)`,
        () =>
            httpJson({
                url: `${GOOGLE_API}/models/${encodeURIComponent(model)}:generateContent`,
                label: 'Google generateContent',
                method: 'POST',
                headers: googleHeaders(),
                body: {
                    contents: [{ parts: [{ text: 'a' }] }],
                    generationConfig: { maxOutputTokens: 1 },
                },
            })
    );
}
