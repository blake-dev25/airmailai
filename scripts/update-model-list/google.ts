import { GoogleGenAI, type Model as GoogleModel } from '@google/genai';
import {
    type DerivedModel,
    type DerivedThinking,
    type ModelProbeResult,
    type OpenRouterIndex,
    type ThinkingLevel,
    MODEL_PROBE_DELAY_MS,
    WEBPAGE_SCRAPE_DELAY_MS,
    fallbackReasoningThinking,
    findOpenRouter,
    formatKnowledgeCutoff,
    pollWithDelay,
    printIdList,
    printModelRow,
    printPollingCacheSummary,
    probeErrorCode,
    scrapeDocsRaw,
    sleep,
    sortLevels,
    stripProviderName,
    supportsOpenRouterParam,
} from './shared';
import { GOOGLE_OVERRIDES, staleOverrideIds } from './overrides';
import { type DocsCache, splitCached } from './docs-cache';
import { type ProbeCache, splitCachedProbes } from './probe-cache';

async function probeGoogleModel(
    client: GoogleGenAI,
    id: string
): Promise<ModelProbeResult> {
    try {
        await client.models.generateContent({
            model: id,
            contents: 'a',
            config: { maxOutputTokens: 1 },
        });
        return { status: 'ok', code: '200' };
    } catch (e) {
        const msg = (e as Error).message ?? String(e);
        const code = probeErrorCode(e);
        if (/no longer available to new users/i.test(msg)) {
            return { status: 'grandfathered', code };
        }
        if (/\b404\b|NOT_FOUND/.test(msg)) {
            return { status: 'dead', code };
        }
        return { status: 'ok', code };
    }
}

function googleModelId(m: GoogleModel): string {
    return m.name?.replace(/^models\//, '') ?? '';
}

function isGoogleChatCandidate(m: GoogleModel): boolean {
    const actions = (m as unknown as Record<string, unknown>).supportedActions;
    return Array.isArray(actions) && actions.includes('generateContent');
}

export async function scrapeGoogleDocsRaw(id: string) {
    return scrapeDocsRaw(`https://ai.google.dev/gemini-api/docs/models/${id}`);
}

interface ScrapedGoogle {
    id: string;
    hasTextInput: boolean;
    hasTextOutput: boolean;
    hasMediaOutput: boolean;
    thinkingSupported: boolean;
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

export function parseGoogleDoc(id: string, md: string): ScrapedGoogle {
    const inputRow = modalityRow(md, 'Inputs?');
    const outputRow = modalityRow(md, 'Output');
    const hasTextInput = /\btext\b/i.test(inputRow);
    const hasTextOutput = /\btext\b/i.test(outputRow);
    const hasMediaOutput = /\b(?:audio|video)\b/i.test(outputRow);
    const thinkingSupported =
        /\*\*(?:Thinking|\[Thinking\]\([^)]*\))\*\*\s+Supported\b/.test(md);
    const koMatch = md.match(/Knowledge cutoff\s+([A-Z][a-z]+ \d{4})/);
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
        thinkingSupported,
        knowledgeCutoff,
        modelCardUrl,
    };
}

export function parseGoogleModelCard(md: string): string | null {
    const m = md.match(/knowledge cutoff date for .*? is ([A-Z][a-z]+ \d{4})/i);
    return m ? abbreviateMonth(m[1]) : null;
}

const GOOGLE_THINKING_DOCS_URL =
    'https://ai.google.dev/gemini-api/docs/thinking';

const GOOGLE_LEVELS = new Set<string>([
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'max',
]);

export function parseGoogleThinkingLevels(
    md: string
): Map<string, DerivedThinking> {
    const table = new Map<string, DerivedThinking>();
    const lines = md
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '');
    const header = lines.findIndex(
        (l, i) =>
            l === 'Model' &&
            lines[i + 1] === 'Default Thinking' &&
            lines[i + 2] === 'Levels Supported'
    );
    if (header === -1) return table;
    for (let i = header + 3; i + 2 < lines.length; i += 3) {
        const id = lines[i];
        if (!/^[a-z0-9][a-z0-9.-]*$/.test(id)) break;
        const defMatch = lines[i + 1].match(/^O(n|ff)(?: \(([a-z]+)\))?$/);
        if (!defMatch) break;
        const rawLevels = lines[i + 2].split(',').map((s) => s.trim());
        if (!rawLevels.every((l) => GOOGLE_LEVELS.has(l))) break;
        const levels = sortLevels(rawLevels as ThinkingLevel[]);
        const isOff = defMatch[1] === 'ff';
        const stated = defMatch[2] as ThinkingLevel | undefined;
        if (isOff) {
            table.set(id, {
                levels: sortLevels(['none', ...levels]),
                defaultLevel: 'none',
            });
        } else if (stated && levels.includes(stated)) {
            table.set(id, { levels, defaultLevel: stated });
        } else if (!stated) {
            table.set(id, {
                levels,
                defaultLevel: levels.includes('medium') ? 'medium' : levels[0],
            });
        }
    }
    return table;
}

async function fetchGoogleThinkingTable(): Promise<
    Map<string, DerivedThinking>
> {
    console.log('scraping Gemini thinking docs for levels');
    try {
        const { status, markdown } = await scrapeDocsRaw(
            GOOGLE_THINKING_DOCS_URL
        );
        if (!markdown) {
            console.log(`⚠ thinking docs scrape failed (HTTP ${status})`);
            return new Map();
        }
        const table = parseGoogleThinkingLevels(markdown);
        if (table.size === 0) {
            console.log(
                '⚠ thinking docs parsed to 0 rows - page layout may have changed'
            );
        } else {
            console.log(`got ${table.size} thinking level rows from docs`);
        }
        return table;
    } catch (e) {
        console.log(`⚠ thinking docs scrape failed: ${(e as Error).message}`);
        return new Map();
    }
}

function deriveGoogle(
    m: GoogleModel,
    openrouter: OpenRouterIndex,
    scraped: ScrapedGoogle,
    thinkingTable: Map<string, DerivedThinking>
): DerivedModel {
    const id = googleModelId(m);
    const o = GOOGLE_OVERRIDES[id];
    const info = findOpenRouter(openrouter, 'google', id, o?.openRouterId);
    const notes: string[] = [];
    const raw = m as unknown as Record<string, unknown>;

    let thinking: DerivedThinking | undefined;
    const fromDocs = thinkingTable.get(id);
    if (o?.thinking) {
        thinking = {
            levels: sortLevels(o.thinking.levels),
            defaultLevel: o.thinking.defaultLevel,
            ...(o.thinking.adaptive ? { adaptive: o.thinking.adaptive } : {}),
        };
    } else if (fromDocs) {
        thinking = fromDocs;
    } else if (
        scraped.thinkingSupported ||
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

    const temperatureMax =
        o?.temperatureMax ??
        (typeof raw.maxTemperature === 'number'
            ? raw.maxTemperature
            : supportsOpenRouterParam(info, 'temperature')
              ? 2
              : undefined);

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
                ? (o?.defaultTemperature ?? 1)
                : undefined,
        tools: o?.tools,
        created: info?.created,
        notes,
    };
}

export interface GooglePipelineResult {
    raw: GoogleModel[];
    models: DerivedModel[];
    skipped: Array<{ id: string; reason: string }>;
    needsLevels: string[];
    missingCutoff: string[];
    grandfathered: string[];
}

export async function pipelineGoogle(
    openrouter: OpenRouterIndex,
    docsCache: DocsCache,
    probeCache: ProbeCache
): Promise<GooglePipelineResult> {
    console.log('starting Google polling');
    const key = process.env.GOOGLE_API_KEY;
    if (!key) throw new Error('GOOGLE_API_KEY missing from .env');
    const client = new GoogleGenAI({ apiKey: key });

    const raw: GoogleModel[] = [];
    for await (const m of await client.models.list()) raw.push(m);

    const thinkingTable = await fetchGoogleThinkingTable();
    const skipped: Array<{ id: string; reason: string }> = [];

    const candidates = raw.filter((m) => {
        const id = googleModelId(m);
        if (!isGoogleChatCandidate(m)) {
            skipped.push({
                id,
                reason: 'no generateContent in supportedActions',
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
    const docOutcomes = [
        ...hits.map(({ item, parsed }) => ({
            m: item,
            id: googleModelId(item),
            status: '200',
            scraped: parsed,
        })),
        ...failures.map(({ item, code }) => ({
            m: item,
            id: googleModelId(item),
            status: code,
            scraped: null,
        })),
        ...(await pollWithDelay(misses, WEBPAGE_SCRAPE_DELAY_MS, async (m) => {
            const id = googleModelId(m);
            const { status, markdown } = await scrapeGoogleDocsRaw(id);
            console.log(`got ${id} docs, ${status}`);
            if (status !== 200 || !markdown) {
                const code = String(status);
                pages.set(id, { code, value: null });
                return { m, id, status: code, scraped: null };
            }
            const scraped = parseGoogleDoc(id, markdown);
            if (!scraped.knowledgeCutoff && scraped.modelCardUrl) {
                await sleep(WEBPAGE_SCRAPE_DELAY_MS);
                const card = await scrapeDocsRaw(scraped.modelCardUrl);
                console.log(`got ${id} model card, ${card.status}`);
                if (card.markdown) {
                    scraped.knowledgeCutoff = parseGoogleModelCard(
                        card.markdown
                    );
                }
            }
            const code = String(status);
            pages.set(id, { code, value: scraped });
            return { m, id, status: code, scraped };
        })),
    ];
    await docsCache.save();

    const docSurvivors: DerivedModel[] = [];
    for (const { m, id, status, scraped } of docOutcomes) {
        if (!scraped) {
            skipped.push({ id, reason: `${status} (no docs page)` });
            continue;
        }
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
        docSurvivors.push(deriveGoogle(m, openrouter, scraped, thinkingTable));
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
            const probe = await probeGoogleModel(client, m.id);
            probeSection.set(m.id, probe);
            const result = {
                model: m,
                id: m.id,
                status: probe.status,
                code: probe.code,
            };
            console.log(`tested ${result.id}, ${result.code}`);
            return result;
        }
    );
    await probeCache.save();

    const probesById = new Map<string, ModelProbeResult>();
    for (const { item, probe } of probeHits) {
        probesById.set(item.id, probe);
    }
    for (const { model, status, code } of freshProbes) {
        probesById.set(model.id, { status, code });
    }

    const grandfathered: string[] = [];
    const models: DerivedModel[] = [];
    for (const model of docSurvivors) {
        const id = model.id;
        const probe = probesById.get(id);
        if (!probe) throw new Error(`Missing Google probe for ${id}`);
        const { status } = probe;
        if (status === 'dead') {
            skipped.push({ id, reason: 'probe 404 (no longer available)' });
            continue;
        }
        if (status === 'grandfathered') grandfathered.push(id);
        models.push(model);
    }

    const needsLevels = models
        .filter((m) => m.notes.some((n) => n.includes('no levels')))
        .map((m) => m.id);
    const missingCutoff = models
        .filter((m) => !m.knowledgeCutoff)
        .map((m) => m.id);
    return { raw, models, skipped, needsLevels, missingCutoff, grandfathered };
}

export function printGooglePipeline(
    r: GooglePipelineResult,
    verbose: boolean
): void {
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
    if (verbose && r.skipped.length > 0) {
        console.log(`\n   ${r.skipped.length} skipped:`);
        for (const s of r.skipped) console.log(`   - ${s.id} - ${s.reason}`);
    }
}

export function printGoogleWarnings(r: GooglePipelineResult): void {
    printIdList(
        `${r.grandfathered.length} grandfathered model(s) - kept (probe 404 with "to new users"):`,
        r.grandfathered
    );
    printIdList(
        `${r.needsLevels.length} thinking model(s) missing levels - add to GOOGLE_OVERRIDES if desired:`,
        r.needsLevels
    );
    printIdList(
        `${r.missingCutoff.length} model(s) missing knowledgeCutoff - add to GOOGLE_OVERRIDES if desired:`,
        r.missingCutoff
    );
    const stale = staleOverrideIds(GOOGLE_OVERRIDES, r.models);
    printIdList(
        `${stale.length} stale GOOGLE_OVERRIDES entry/entries - model not in current list, consider removing:`,
        stale
    );
}
