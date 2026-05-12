// Fetches each first-party provider's official model list and emits the
// matching packages/courierai_web/src/lib/models/<provider>.ts file.
//
// OpenRouter is metadata enrichment only. It never decides first-party
// availability; provider APIs do that, with targeted official-doc scraping
// filling gaps where APIs/OpenRouter do not expose the fields CourierAI needs.
//
// Run dry (prints, no writes):
//     bun scripts/update-model-list.ts
// Run with writes:
//     bun scripts/update-model-list.ts --write
//
// Bun auto-loads .env at the repo root.

import { resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import type { Model as GoogleModel } from '@google/genai';
import OpenAI from 'openai';
import TurndownService from 'turndown';
import {
    ANTHROPIC_OVERRIDES,
    GOOGLE_OVERRIDES,
    OPENAI_OVERRIDES,
} from './overrides';

const WRITE = process.argv.includes('--write');
const VERBOSE = process.argv.includes('--verbose');
const RETRIEVE_TEST = process.argv.includes('--retrieve-test');
const MODEL_TEST_IDX = process.argv.indexOf('--model-test');
const MODEL_TEST_PROVIDER =
    MODEL_TEST_IDX >= 0 ? process.argv[MODEL_TEST_IDX + 1] : undefined;
const MODEL_TEST_ID =
    MODEL_TEST_IDX >= 0 ? process.argv[MODEL_TEST_IDX + 2] : undefined;
const SCRAPE_TEST_IDX = process.argv.indexOf('--scrape-test');
const SCRAPE_TEST_ID =
    SCRAPE_TEST_IDX >= 0 ? process.argv[SCRAPE_TEST_IDX + 1] : undefined;
const GOOGLE_SCRAPE_TEST_IDX = process.argv.indexOf('--google-scrape-test');
const GOOGLE_SCRAPE_TEST_ID =
    GOOGLE_SCRAPE_TEST_IDX >= 0
        ? process.argv[GOOGLE_SCRAPE_TEST_IDX + 1]
        : undefined;

const PROVIDER_FLAGS = new Set(
    process.argv.filter((a) =>
        ['--anthropic', '--openai', '--google'].includes(a)
    )
);
const RUN_ALL = PROVIDER_FLAGS.size === 0;
const RUN_ANTHROPIC = RUN_ALL || PROVIDER_FLAGS.has('--anthropic');
const RUN_OPENAI = RUN_ALL || PROVIDER_FLAGS.has('--openai');
const RUN_GOOGLE = RUN_ALL || PROVIDER_FLAGS.has('--google');
const NEEDS_OPENROUTER = RUN_OPENAI || RUN_GOOGLE;

const MODELS_DIR = resolve(
    import.meta.dir,
    '../packages/courierai_web/src/lib/models'
);
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';
const WEBPAGE_SCRAPE_DELAY_MS = 2000;
const MODEL_PROBE_DELAY_MS = 2000;

type ThinkingLevel =
    | 'none'
    | 'minimal'
    | 'low'
    | 'medium'
    | 'high'
    | 'max'
    | 'xhigh';

interface DerivedThinking {
    levels: ThinkingLevel[];
    defaultLevel: ThinkingLevel;
    adaptive?: 'optional' | 'required';
}

interface DerivedModel {
    id: string;
    name: string;
    contextWindow: number | null;
    maxOutputTokens: number | null;
    knowledgeCutoff?: string;
    thinking?: DerivedThinking;
    temperatureMax?: number;
    defaultTemperature?: number;
    created?: number;
    notes: string[];
}

interface OpenRouterRawModel {
    id?: string;
    name?: string;
    created?: number;
    context_length?: number;
    knowledge_cutoff?: string | null;
    architecture?: {
        input_modalities?: string[];
        output_modalities?: string[];
    };
    top_provider?: {
        context_length?: number;
        max_completion_tokens?: number;
    };
    supported_parameters?: string[];
}

interface OpenRouterModelInfo {
    id: string;
    provider: string;
    localId: string;
    name: string;
    created: number;
    contextWindow: number | null;
    maxOutputTokens: number | null;
    knowledgeCutoff: string | null;
    inputModalities: string[];
    outputModalities: string[];
    supportedParams: string[];
}

interface OpenRouterIndex {
    byProvider: Map<string, Map<string, OpenRouterModelInfo>>;
}

const LEVEL_ORDER: ThinkingLevel[] = [
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
];
const FALLBACK_REASONING_LEVELS: ThinkingLevel[] = ['none', 'low', 'high'];

function sortLevels(levels: ThinkingLevel[]): ThinkingLevel[] {
    const set = new Set(levels);
    return LEVEL_ORDER.filter((l) => set.has(l));
}

function fallbackReasoningThinking(): DerivedThinking {
    return {
        levels: [...FALLBACK_REASONING_LEVELS],
        defaultLevel: 'none',
    };
}

function stripProviderName(name: string, provider: string): string {
    const prefix = `${provider}: `;
    return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

function formatKnowledgeCutoff(
    raw: string | null | undefined
): string | undefined {
    if (!raw) return undefined;
    const m = raw.match(/^(\d{4})-(\d{2})-\d{2}$/);
    if (!m) return raw;
    const month = [
        'Jan',
        'Feb',
        'Mar',
        'Apr',
        'May',
        'Jun',
        'Jul',
        'Aug',
        'Sep',
        'Oct',
        'Nov',
        'Dec',
    ][Number(m[2]) - 1];
    return month ? `${month} ${m[1]}` : raw;
}

// ---------- shared printing helpers ----------

function formatThinking(
    m: DerivedModel,
    kind: 'anthropic' | 'default'
): string {
    if (!m.thinking) return 'no thinking';
    if (kind === 'anthropic') {
        return `thinking[${m.thinking.adaptive ?? 'enabled-only'}]: ${m.thinking.levels.join('/')}`;
    }
    return `thinking: ${m.thinking.levels.join('/')} (default ${m.thinking.defaultLevel})`;
}

function printModelRow(
    m: DerivedModel,
    opts: {
        padWidth: number;
        thinkingKind: 'anthropic' | 'default';
        showNotes: boolean;
    }
): void {
    const ctx = m.contextWindow ?? '?';
    const out = m.maxOutputTokens ?? '?';
    const temp =
        m.temperatureMax === undefined
            ? 'no temp'
            : `temp<=${m.temperatureMax}`;
    console.log(`  ${m.id.padEnd(opts.padWidth)} "${m.name}"`);
    console.log(
        `    ctx=${ctx}  out=${out}  ${temp}  ${formatThinking(m, opts.thinkingKind)}`
    );
    if (m.knowledgeCutoff) console.log(`    cutoff=${m.knowledgeCutoff}`);
    if (opts.showNotes) for (const n of m.notes) console.log(`    ! ${n}`);
}

function printIdList(header: string, ids: string[]): void {
    if (ids.length === 0) return;
    console.log(`\n   ${header}`);
    for (const id of ids) console.log(`   - ${id}`);
}

// ---------- shared file emission ----------

function emitProviderFile(
    providerId: string,
    providerName: string,
    models: DerivedModel[]
): string {
    const header = `import type { ProviderOption } from './types';

// NOTE FOR LLMS: NEVER MANUALLY MODIFY IDS/NAMES, THEY ARE CORRECT
// This file is automatically written over by scripts/update-model-list.ts, edits will not be saved
export const ${providerId.toUpperCase()}: ProviderOption = {
    id: '${providerId}',
    name: '${providerName}',
    models: [
`;
    const body = models.map(emitModelEntry).join('');
    const footer = `    ],
};
`;
    return header + body + footer;
}

function emitModelEntry(m: DerivedModel): string {
    const maxOutputTokens = m.maxOutputTokens ?? 0;
    const defaultMaxTokens =
        maxOutputTokens > 0 ? Math.min(8192, maxOutputTokens) : 8192;
    const lines: string[] = [];
    lines.push('        {');
    lines.push(`            id: '${m.id}',`);
    lines.push(`            name: '${m.name.replace(/'/g, "\\'")}',`);
    lines.push('            params: {');
    lines.push(`                contextWindow: ${m.contextWindow ?? 0},`);
    lines.push(`                maxOutputTokens: ${maxOutputTokens},`);
    lines.push(`                defaultMaxTokens: ${defaultMaxTokens},`);
    if (m.temperatureMax !== undefined) {
        lines.push(`                temperatureMax: ${m.temperatureMax},`);
        lines.push(
            `                defaultTemperature: ${m.defaultTemperature ?? 1},`
        );
    }
    if (m.knowledgeCutoff) {
        lines.push(`                knowledgeCutoff: '${m.knowledgeCutoff}',`);
    }
    if (m.thinking) {
        lines.push('                thinking: {');
        const lv = m.thinking.levels.map((l) => `'${l}'`).join(', ');
        lines.push(`                    levels: [${lv}],`);
        lines.push(
            `                    defaultLevel: '${m.thinking.defaultLevel}',`
        );
        if (m.thinking.adaptive) {
            lines.push(
                `                    adaptive: '${m.thinking.adaptive}',`
            );
        }
        lines.push('                },');
    }
    lines.push('            },');
    lines.push('        },');
    return lines.join('\n') + '\n';
}

async function emitAndMaybeWrite(
    filename: string,
    content: string
): Promise<void> {
    if (VERBOSE) {
        console.log(`\n--- Generated ${filename} ---\n`);
        console.log(content);
    }
    if (WRITE) {
        const path = resolve(MODELS_DIR, filename);
        await Bun.write(path, content);
        console.log(`\n✓ wrote ${content.length} bytes to ${path}`);
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollWithDelay<T, R>(
    items: T[],
    delayMs: number,
    fn: (t: T) => Promise<R>
): Promise<R[]> {
    const out: R[] = [];
    for (let i = 0; i < items.length; i++) {
        if (i > 0) await sleep(delayMs);
        out.push(await fn(items[i]));
    }
    return out;
}

type ModelProbeStatus = 'ok' | 'grandfathered' | 'dead';
interface ModelProbeResult {
    status: ModelProbeStatus;
    code: string;
}

function probeErrorCode(e: unknown): string {
    const raw =
        e && typeof e === 'object'
            ? (e as { status?: unknown; code?: unknown; message?: unknown })
            : {};
    if (typeof raw.status === 'number' || typeof raw.status === 'string') {
        return String(raw.status);
    }
    if (typeof raw.code === 'number' || typeof raw.code === 'string') {
        return String(raw.code);
    }
    const msg = typeof raw.message === 'string' ? raw.message : String(e);
    return msg.match(/\b(\d{3})\b/)?.[1] ?? 'error';
}

// ---------- targeted docs scraping ----------

const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
});
turndown.remove(['style', 'script', 'noscript', 'svg', 'iframe']);

async function scrapeDocsRaw(
    url: string
): Promise<{ url: string; status: number; markdown: string | null }> {
    const res = await fetch(url);
    if (!res.ok) return { url, status: res.status, markdown: null };
    const html = await res.text();
    return { url, status: res.status, markdown: turndown.turndown(html) };
}

async function runScrapeTest<T>(
    id: string,
    fetcher: (
        id: string
    ) => Promise<{ url: string; status: number; markdown: string | null }>,
    parser: (id: string, md: string) => T
): Promise<void> {
    const { url, status, markdown } = await fetcher(id);
    console.log(`URL:    ${url}`);
    console.log(`Status: ${status}`);
    if (markdown == null) {
        console.log('(no markdown — non-200 response)');
        return;
    }
    console.log(`Length: ${markdown.length} chars`);
    const parsed = parser(id, markdown);
    console.log('\n--- parsed ---');
    console.log(JSON.stringify(parsed, null, 2));
    if (process.argv.includes('--show-md')) {
        console.log('\n--- markdown ---');
        console.log(markdown);
    }
}

// ---------- OpenRouter metadata ----------

async function fetchOpenRouterIndex(): Promise<OpenRouterIndex> {
    console.log('starting OpenRouter polling');
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error('OPENROUTER_API_KEY missing from .env');
    const res = await fetch(OPENROUTER_URL, {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) throw new Error(`OpenRouter /models HTTP ${res.status}`);
    const json = (await res.json()) as { data?: OpenRouterRawModel[] };
    const byProvider = new Map<string, Map<string, OpenRouterModelInfo>>();

    for (const raw of json.data ?? []) {
        if (!raw.id || !raw.name) continue;
        const [provider, ...rest] = raw.id.split('/');
        const localId = rest.join('/');
        if (!provider || !localId) continue;
        const info: OpenRouterModelInfo = {
            id: raw.id,
            provider,
            localId,
            name: raw.name,
            created: raw.created ?? 0,
            contextWindow:
                raw.top_provider?.context_length ?? raw.context_length ?? null,
            maxOutputTokens: raw.top_provider?.max_completion_tokens ?? null,
            knowledgeCutoff: raw.knowledge_cutoff ?? null,
            inputModalities: raw.architecture?.input_modalities ?? [],
            outputModalities: raw.architecture?.output_modalities ?? [],
            supportedParams: raw.supported_parameters ?? [],
        };
        let providerMap = byProvider.get(provider);
        if (!providerMap) {
            providerMap = new Map();
            byProvider.set(provider, providerMap);
        }
        providerMap.set(localId, info);
    }

    const count = Array.from(byProvider.values()).reduce(
        (n, map) => n + map.size,
        0
    );
    console.log(`Got ${count} models from OpenRouter`);
    return { byProvider };
}

function findOpenRouter(
    index: OpenRouterIndex,
    provider: string,
    id: string,
    overrideId?: string
): OpenRouterModelInfo | undefined {
    const providerMap = index.byProvider.get(provider);
    if (!providerMap) return undefined;
    const candidates = new Set<string>();
    if (overrideId) candidates.add(overrideId);
    candidates.add(id);
    candidates.add(id.replace(/-\d{4}-\d{2}-\d{2}$/, ''));
    if (provider === 'openai' && id.endsWith('-chat-latest')) {
        candidates.add(id.replace(/-chat-latest$/, '-chat'));
    }
    if (provider === 'google' && /^gemini-2\.0-/.test(id)) {
        candidates.add(`${id}-001`);
    }
    for (const candidate of candidates) {
        const found = providerMap.get(candidate);
        if (found) return found;
    }
    return undefined;
}

function supportsOpenRouterParam(
    info: OpenRouterModelInfo | undefined,
    param: string
): boolean {
    return info?.supportedParams.includes(param) ?? false;
}

// ---------- Anthropic ----------

async function fetchAnthropic(): Promise<DerivedModel[]> {
    console.log('starting Anthropic polling');
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY missing from .env');
    const client = new Anthropic({ apiKey: key });

    const out: DerivedModel[] = [];
    for await (const m of client.models.list({ limit: 1000 })) {
        out.push(applyAnthropicOverrides(deriveAnthropic(m)));
    }
    console.log(
        `starting Anthropic 404 polling (${out.length} models, ${MODEL_PROBE_DELAY_MS / 1000}s spacing)`
    );
    const probes = await pollWithDelay(out, MODEL_PROBE_DELAY_MS, async (m) => {
        const probe = await probeAnthropicModel(client, m.id);
        console.log(`tested ${m.id}, ${probe.code}`);
        return { model: m, probe };
    });

    const kept: DerivedModel[] = [];
    const dead: string[] = [];
    for (const { model, probe } of probes) {
        if (probe.status === 'dead') dead.push(model.id);
        else kept.push(model);
    }
    printIdList(
        `${dead.length} Anthropic model(s) failed runtime probe — skipped:`,
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
        }
    }

    if (m.max_input_tokens == null) notes.push('max_input_tokens missing');
    if (m.max_tokens == null) notes.push('max_tokens missing');

    return {
        id: m.id,
        name: m.display_name,
        contextWindow: m.max_input_tokens,
        maxOutputTokens: m.max_tokens,
        thinking,
        temperatureMax: 1,
        defaultTemperature: 1,
        notes,
    };
}

function applyAnthropicOverrides(d: DerivedModel): DerivedModel {
    const o = ANTHROPIC_OVERRIDES[d.id];
    if (!o) return d;
    if (o.idAlias) d.id = o.idAlias;
    if (o.knowledgeCutoff) d.knowledgeCutoff = o.knowledgeCutoff;
    if (o.contextWindow !== undefined) d.contextWindow = o.contextWindow;
    if (o.maxOutputTokens !== undefined) d.maxOutputTokens = o.maxOutputTokens;
    if (o.thinkingExtraLevels && d.thinking) {
        d.thinking.levels = sortLevels([
            ...d.thinking.levels,
            ...o.thinkingExtraLevels,
        ]);
    }
    return d;
}

function printAnthropicSummary(label: string, models: DerivedModel[]): void {
    console.log(`\n=== ${label} — ${models.length} models ===`);
    for (const m of models) {
        printModelRow(m, {
            padWidth: 40,
            thinkingKind: 'anthropic',
            showNotes: true,
        });
    }
}

function printAnthropicWarnings(models: DerivedModel[]): void {
    const missing = models.filter((m) => !m.knowledgeCutoff).map((m) => m.id);
    printIdList(
        `${missing.length} model(s) missing knowledgeCutoff — add to OVERRIDES if desired:`,
        missing
    );
}

// ---------- OpenAI ----------

interface OpenAIRaw {
    id: string;
    created: number;
    ownedBy: string;
}

async function fetchOpenAI(): Promise<OpenAIRaw[]> {
    console.log('starting OpenAI polling');
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY missing from .env');
    const client = new OpenAI({ apiKey: key });
    const out: OpenAIRaw[] = [];
    for await (const m of client.models.list()) {
        out.push({ id: m.id, created: m.created, ownedBy: m.owned_by });
    }
    out.sort((a, b) => b.created - a.created);
    return out;
}

function isOpenAIChatCandidate(id: string): boolean {
    if (!(id.startsWith('gpt-') || /^o[1-9](?:-|$)/.test(id))) return false;
    return !/(?:audio|image|realtime|search-api|transcribe|tts|embedding|moderation|oss|safeguard)/.test(
        id
    );
}

function openaiAliasId(id: string): string {
    return id.replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

function dedupeOpenAIToAliases(raws: OpenAIRaw[]): OpenAIRaw[] {
    const seen = new Set<string>();
    const out: OpenAIRaw[] = [];
    for (const r of raws) {
        const id = openaiAliasId(r.id);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ ...r, id });
    }
    return out;
}

function inferOpenAIThinking(
    id: string,
    info: OpenRouterModelInfo | undefined
): DerivedThinking | undefined {
    if (!supportsOpenRouterParam(info, 'reasoning')) return undefined;
    if (/-chat(?:-latest)?$/.test(id) || id.includes('search-preview')) {
        return undefined;
    }
    if (!id.startsWith('gpt-')) return undefined;
    if (id.includes('-pro')) {
        return {
            levels: ['medium', 'high', 'xhigh'],
            defaultLevel: 'medium',
        };
    }
    if (/^gpt-5\.5(?:-|$)/.test(id)) {
        return {
            levels: ['none', 'low', 'medium', 'high', 'xhigh'],
            defaultLevel: 'medium',
        };
    }
    if (/^gpt-5\.[2-4](?:-|$)/.test(id)) {
        return {
            levels: ['none', 'low', 'medium', 'high', 'xhigh'],
            defaultLevel: 'none',
        };
    }
    if (/^gpt-5\.1(?:-|$)/.test(id)) {
        return {
            levels: ['none', 'low', 'medium', 'high'],
            defaultLevel: 'none',
        };
    }
    if (/^gpt-5(?:-|$)/.test(id)) {
        return {
            levels: ['minimal', 'low', 'medium', 'high'],
            defaultLevel: 'minimal',
        };
    }
    return undefined;
}

function inferOpenAIKnowledgeCutoff(
    id: string,
    info: OpenRouterModelInfo | undefined
): string | undefined {
    const fromOpenRouter = formatKnowledgeCutoff(info?.knowledgeCutoff);
    if (fromOpenRouter) return fromOpenRouter;
    if (/^gpt-5\.[2-4](?:-|$)/.test(id)) return 'Aug 2025';
    if (/^gpt-5\.1(?:-|$)/.test(id)) return 'Sep 2024';
    if (/^o[34].*deep-research/.test(id)) return 'Jun 2024';
    return undefined;
}

async function scrapeOpenAIDocsRaw(id: string) {
    const slug = openaiDocsSlug(id);
    return scrapeDocsRaw(
        `https://developers.openai.com/api/docs/models/${slug}`
    );
}

interface ScrapedOpenAI {
    id: string;
    displayName: string | null;
    contextWindow: number | null;
    maxOutputTokens: number | null;
    knowledgeCutoff: string | null;
    reasoning?:
        | {
              kind: 'levels-known';
              levels: ThinkingLevel[];
              defaultLevel: ThinkingLevel;
          }
        | { kind: 'levels-unknown' };
}

const SHORT_MONTHS = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
];

function openaiDocsSlug(id: string): string {
    return id.replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

function shortenCutoff(raw: string): string | null {
    const m = raw.match(/^(\w{3}) \d{1,2}, (\d{4})$/);
    if (!m) return null;
    const month = m[1];
    if (!SHORT_MONTHS.includes(month)) return null;
    return `${month} ${m[2]}`;
}

function parseReasoningEffort(raw: string): ScrapedOpenAI['reasoning'] {
    const tokens = raw
        .replace(/\band\b/g, ',')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    let defaultLevel: ThinkingLevel | undefined;
    const levels: ThinkingLevel[] = [];
    const valid: ThinkingLevel[] = [
        'none',
        'minimal',
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
    ];
    for (const t of tokens) {
        const isDefault = /\(default\)/.test(t);
        const lvl = t.replace(/\(default\)/, '').trim() as ThinkingLevel;
        if (!valid.includes(lvl)) continue;
        levels.push(lvl);
        if (isDefault) defaultLevel = lvl;
    }
    if (levels.length === 0) return undefined;
    return {
        kind: 'levels-known',
        levels,
        defaultLevel: defaultLevel ?? levels[0],
    };
}

function parseOpenAIDoc(id: string, md: string): ScrapedOpenAI {
    const ctx = md.match(/^([\d,]+) context window$/m)?.[1];
    const out = md.match(/^([\d,]+) max output tokens$/m)?.[1];
    const ko = md.match(/^(\w+ \d{1,2}, \d{4}) knowledge cutoff$/m)?.[1];

    const effortMatch =
        md.match(/[Rr]easoning\.effort supports[:\s]+([^.\n]+)\.?/)?.[1] ??
        md.match(/supports reasoning\.effort[:\s]+([^.\n]+)\.?/)?.[1];
    let reasoning: ScrapedOpenAI['reasoning'];
    if (effortMatch) {
        reasoning = parseReasoningEffort(effortMatch);
    } else if (/^Reasoning token support$/m.test(md)) {
        reasoning = { kind: 'levels-unknown' };
    }

    const nameMatch = md.match(/(?:^|\n)([A-Za-z0-9.\- ]+?)\n+Default\n/);
    const displayName = nameMatch?.[1]?.trim() ?? null;

    return {
        id,
        displayName,
        contextWindow: ctx ? Number(ctx.replace(/,/g, '')) : null,
        maxOutputTokens: out ? Number(out.replace(/,/g, '')) : null,
        knowledgeCutoff: ko ? shortenCutoff(ko) : null,
        reasoning,
    };
}

async function applyOpenAIDocFallback(models: DerivedModel[]): Promise<void> {
    console.log(
        `starting OpenAI docs polling (${models.length} pages, ${WEBPAGE_SCRAPE_DELAY_MS / 1000}s spacing)`
    );
    const outcomes = await pollWithDelay(
        models,
        WEBPAGE_SCRAPE_DELAY_MS,
        async (model) => {
            const { status, markdown } = await scrapeOpenAIDocsRaw(model.id);
            console.log(`got ${model.id} docs, ${status}`);
            return {
                id: model.id,
                status,
                parsed:
                    status === 200 && markdown
                        ? parseOpenAIDoc(model.id, markdown)
                        : null,
            };
        }
    );
    const parsedById = new Map(outcomes.map((o) => [o.id, o]));

    for (const model of models) {
        const outcome = parsedById.get(model.id);
        if (!outcome?.parsed) continue;
        const parsed = outcome.parsed;
        if (model.name === model.id && parsed.displayName) {
            model.name = parsed.displayName;
        }
        model.contextWindow = parsed.contextWindow ?? model.contextWindow;
        model.maxOutputTokens = parsed.maxOutputTokens ?? model.maxOutputTokens;
        model.knowledgeCutoff = parsed.knowledgeCutoff ?? model.knowledgeCutoff;
        if (!model.thinking && parsed.reasoning?.kind === 'levels-known') {
            model.thinking = {
                levels: sortLevels(parsed.reasoning.levels),
                defaultLevel: parsed.reasoning.defaultLevel,
            };
            model.notes = model.notes.filter(
                (n) => !n.includes('reasoning supported')
            );
        } else if (
            !model.thinking &&
            parsed.reasoning?.kind === 'levels-unknown' &&
            !model.notes.some((n) => n.includes('reasoning supported'))
        ) {
            model.notes.push('reasoning supported but no inferred levels');
        }
    }
}

async function probeOpenAIModel(
    client: OpenAI,
    id: string
): Promise<ModelProbeResult> {
    try {
        await client.responses.create({
            model: id,
            input: 'a',
            // OpenAI Responses rejects values below 16 before checking model
            // availability, so use the smallest value that reaches the model.
            max_output_tokens: 16,
        });
        return { status: 'ok', code: '200' };
    } catch (e) {
        const msg = (e as Error).message ?? String(e);
        const code = probeErrorCode(e);
        if (
            code === '404' ||
            /model not found|not found .*model|unsupported|not supported/i.test(
                msg
            )
        ) {
            return { status: 'dead', code };
        }
        return { status: 'ok', code };
    }
}

async function probeOpenAIModels(
    models: DerivedModel[],
    skipped: Array<{ id: string; reason: string }>
): Promise<DerivedModel[]> {
    console.log(
        `starting OpenAI 404 polling (${models.length} models, ${MODEL_PROBE_DELAY_MS / 1000}s spacing)`
    );
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY missing from .env');
    const client = new OpenAI({ apiKey: key });

    const probes = await pollWithDelay(
        models,
        MODEL_PROBE_DELAY_MS,
        async (m) => {
            const probe = await probeOpenAIModel(client, m.id);
            console.log(`tested ${m.id}, ${probe.code}`);
            return { model: m, probe };
        }
    );

    const kept: DerivedModel[] = [];
    for (const { model, probe } of probes) {
        if (probe.status === 'dead') {
            skipped.push({
                id: model.id,
                reason: `runtime probe ${probe.code} (not available via Responses)`,
            });
        } else {
            kept.push(model);
        }
    }
    return kept;
}

interface OpenAIPipelineResult {
    models: DerivedModel[];
    skipped: Array<{ id: string; reason: string }>;
    needsLevels: string[];
    missingCutoff: string[];
}

function deriveOpenAI(
    raw: OpenAIRaw,
    openrouter: OpenRouterIndex
): DerivedModel {
    const o = OPENAI_OVERRIDES[raw.id];
    const info = findOpenRouter(openrouter, 'openai', raw.id, o?.openRouterId);

    const contextWindow = o?.contextWindow ?? info?.contextWindow ?? null;
    const maxOutputTokens = o?.maxOutputTokens ?? info?.maxOutputTokens ?? null;

    const thinking = o?.thinking
        ? {
              levels: sortLevels(o.thinking.levels),
              defaultLevel: o.thinking.defaultLevel,
          }
        : inferOpenAIThinking(raw.id, info);

    const needsLevels =
        supportsOpenRouterParam(info, 'reasoning') && thinking === undefined;

    const supportsTemperature =
        o?.temperatureMax !== undefined ||
        supportsOpenRouterParam(info, 'temperature');
    const notes: string[] = [];
    if (needsLevels) {
        notes.push('reasoning supported but no inferred levels');
    }

    if (!info) {
        notes.push('missing OpenRouter metadata');
    }

    return {
        id: raw.id,
        name:
            o?.name ?? (info ? stripProviderName(info.name, 'OpenAI') : raw.id),
        contextWindow,
        maxOutputTokens,
        knowledgeCutoff:
            o?.knowledgeCutoff ?? inferOpenAIKnowledgeCutoff(raw.id, info),
        thinking,
        temperatureMax: supportsTemperature
            ? (o?.temperatureMax ?? 2)
            : undefined,
        defaultTemperature: supportsTemperature
            ? (o?.defaultTemperature ?? 1)
            : undefined,
        created: raw.created,
        notes,
    };
}

async function pipelineOpenAI(
    openrouter: OpenRouterIndex
): Promise<OpenAIPipelineResult> {
    const raws = await fetchOpenAI();
    const aliases = dedupeOpenAIToAliases(raws).filter((r) =>
        isOpenAIChatCandidate(r.id)
    );

    const models: DerivedModel[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];

    for (const raw of aliases) {
        models.push(deriveOpenAI(raw, openrouter));
    }

    await applyOpenAIDocFallback(models);
    for (const model of models) {
        if (model.notes.some((n) => n.includes('reasoning supported'))) {
            model.thinking = fallbackReasoningThinking();
            model.notes = model.notes.filter(
                (n) => !n.includes('reasoning supported')
            );
        }
    }

    const completeModels = models.filter((m) => {
        if (m.contextWindow != null && m.maxOutputTokens != null) return true;
        skipped.push({
            id: m.id,
            reason: 'missing context window / max output tokens after metadata fallback',
        });
        return false;
    });

    const probedModels = await probeOpenAIModels(completeModels, skipped);

    const needsLevels = models
        .filter((m) => m.notes.some((n) => n.includes('reasoning supported')))
        .map((m) => m.id);
    const missingCutoff = probedModels
        .filter((m) => !m.knowledgeCutoff)
        .map((m) => m.id);
    return { models: probedModels, skipped, needsLevels, missingCutoff };
}

function printOpenAIPipeline(r: OpenAIPipelineResult): void {
    console.log(
        `\n=== OpenAI — ${r.models.length} chat models (${r.skipped.length} skipped) ===`
    );
    for (const m of r.models) {
        printModelRow(m, {
            padWidth: 40,
            thinkingKind: 'default',
            showNotes: false,
        });
    }
    if (r.skipped.length > 0) {
        console.log(`\n   ${r.skipped.length} skipped:`);
        for (const s of r.skipped) console.log(`   - ${s.id} — ${s.reason}`);
    }
}

function printOpenAIWarnings(r: OpenAIPipelineResult): void {
    printIdList(
        `${r.needsLevels.length} reasoning model(s) have OpenRouter reasoning support but no inferred levels — add to OPENAI_OVERRIDES if desired:`,
        r.needsLevels
    );
    printIdList(
        `${r.missingCutoff.length} model(s) missing knowledgeCutoff — add to OPENAI_OVERRIDES if desired:`,
        r.missingCutoff
    );
}

// ---------- Google ----------

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

async function scrapeGoogleDocsRaw(id: string) {
    return scrapeDocsRaw(`https://ai.google.dev/gemini-api/docs/models/${id}`);
}

interface ScrapedGoogle {
    id: string;
    hasTextOutput: boolean;
    thinkingSupported: boolean;
    knowledgeCutoff: string | null;
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

function parseGoogleDoc(id: string, md: string): ScrapedGoogle {
    const hasTextOutput = /\*\*Output\*\*\s+Text\b/.test(md);
    const thinkingSupported = /\*\*Thinking\*\*\s+Supported\b/.test(md);
    const koMatch = md.match(/Knowledge cutoff\s+([A-Z][a-z]+ \d{4})/);
    const knowledgeCutoff = koMatch
        ? koMatch[1].replace(/^[A-Z][a-z]+/, (m) => MONTH_ABBR[m] ?? m)
        : null;
    return { id, hasTextOutput, thinkingSupported, knowledgeCutoff };
}

function deriveGoogle(
    m: GoogleModel,
    openrouter: OpenRouterIndex,
    scraped: ScrapedGoogle
): DerivedModel {
    const id = googleModelId(m);
    const o = GOOGLE_OVERRIDES[id];
    const info = findOpenRouter(openrouter, 'google', id, o?.openRouterId);
    const notes: string[] = [];
    const raw = m as unknown as Record<string, unknown>;

    let thinking: DerivedThinking | undefined;
    if (o?.thinking) {
        thinking = {
            levels: sortLevels(o.thinking.levels),
            defaultLevel: o.thinking.defaultLevel,
        };
    } else if (
        scraped.thinkingSupported ||
        supportsOpenRouterParam(info, 'reasoning')
    ) {
        thinking = fallbackReasoningThinking();
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
        created: info?.created,
        notes,
    };
}

interface GooglePipelineResult {
    raw: GoogleModel[];
    models: DerivedModel[];
    skipped: Array<{ id: string; reason: string }>;
    needsLevels: string[];
    missingCutoff: string[];
    grandfathered: string[];
}

async function pipelineGoogle(
    openrouter: OpenRouterIndex
): Promise<GooglePipelineResult> {
    console.log('starting Google polling');
    const key = process.env.GOOGLE_API_KEY;
    if (!key) throw new Error('GOOGLE_API_KEY missing from .env');
    const client = new GoogleGenAI({ apiKey: key });

    const raw: GoogleModel[] = [];
    for await (const m of await client.models.list()) raw.push(m);

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

    console.log(
        `starting Google docs polling (${candidates.length} pages, ${WEBPAGE_SCRAPE_DELAY_MS / 1000}s spacing)`
    );
    const docOutcomes = await pollWithDelay(
        candidates,
        WEBPAGE_SCRAPE_DELAY_MS,
        async (m) => {
            const id = googleModelId(m);
            const { status, markdown } = await scrapeGoogleDocsRaw(id);
            console.log(`got ${id} docs, ${status}`);
            return { m, id, status, markdown };
        }
    );

    const docSurvivors: DerivedModel[] = [];
    for (const { m, id, status, markdown } of docOutcomes) {
        if (status !== 200 || !markdown) {
            skipped.push({ id, reason: `${status} (no docs page)` });
            continue;
        }
        const scraped = parseGoogleDoc(id, markdown);
        if (!scraped.hasTextOutput) {
            skipped.push({
                id,
                reason: 'output is not Text (TTS / image / etc.)',
            });
            continue;
        }
        docSurvivors.push(deriveGoogle(m, openrouter, scraped));
    }

    console.log(
        `starting Google 404 polling (${docSurvivors.length} models, ${MODEL_PROBE_DELAY_MS / 1000}s spacing)`
    );
    const probes = await pollWithDelay(
        docSurvivors,
        MODEL_PROBE_DELAY_MS,
        async (m) => {
            const probe = await probeGoogleModel(client, m.id);
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

    const grandfathered: string[] = [];
    const models: DerivedModel[] = [];
    for (const { model, id, status } of probes) {
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

function printGooglePipeline(r: GooglePipelineResult): void {
    console.log(
        `\n=== Google — ${r.models.length} chat models (${r.skipped.length} skipped) ===`
    );
    for (const m of r.models) {
        printModelRow(m, {
            padWidth: 50,
            thinkingKind: 'default',
            showNotes: true,
        });
    }
    if (VERBOSE && r.skipped.length > 0) {
        console.log(`\n   ${r.skipped.length} skipped:`);
        for (const s of r.skipped) console.log(`   - ${s.id} — ${s.reason}`);
    }
}

function printGoogleWarnings(r: GooglePipelineResult): void {
    printIdList(
        `${r.grandfathered.length} grandfathered model(s) — kept (probe 404 with "to new users"):`,
        r.grandfathered
    );
    printIdList(
        `${r.needsLevels.length} thinking model(s) missing levels — add to GOOGLE_OVERRIDES if desired:`,
        r.needsLevels
    );
    printIdList(
        `${r.missingCutoff.length} model(s) missing knowledgeCutoff — add to GOOGLE_OVERRIDES if desired:`,
        r.missingCutoff
    );
}

// ---------- tiers.ts merge ----------

function updateTiersFile(
    text: string,
    sectionComment: string,
    derivedIds: string[]
): {
    text: string;
    newIds: string[];
    staleEntries: Array<{ id: string; tier: string }>;
} {
    const lines = text.split('\n');
    const sectionIdx = lines.findIndex((l) => l.trim() === sectionComment);
    if (sectionIdx === -1) {
        throw new Error(
            `Could not find section "${sectionComment}" in tiers.ts`
        );
    }
    let endIdx = lines.length;
    for (let i = sectionIdx + 1; i < lines.length; i++) {
        const t = lines[i].trim();
        if (t.startsWith('//') || t.startsWith('};')) {
            endIdx = i;
            break;
        }
    }

    const sectionEntries: Array<{ id: string; tier: string }> = [];
    for (let i = sectionIdx + 1; i < endIdx; i++) {
        const m = lines[i].match(/^\s*'([^']+)':\s*'([^']+)',?\s*$/);
        if (m) sectionEntries.push({ id: m[1], tier: m[2] });
    }

    const allExisting = new Set<string>();
    for (const l of lines) {
        const m = l.match(/^\s*'([^']+)':/);
        if (m) allExisting.add(m[1]);
    }
    const newIds = derivedIds.filter((id) => !allExisting.has(id));

    const derivedSet = new Set(derivedIds);
    const staleEntries = sectionEntries.filter((e) => !derivedSet.has(e.id));

    const combined = [
        ...sectionEntries,
        ...newIds.map((id) => ({ id, tier: 'legacy' })),
    ];
    combined.sort((a, b) =>
        a.id.localeCompare(b.id, undefined, { numeric: true })
    );
    const sortedLines = combined.map((e) => `    '${e.id}': '${e.tier}',`);

    const updated = [
        ...lines.slice(0, sectionIdx + 1),
        ...sortedLines,
        ...lines.slice(endIdx),
    ];
    const newText = updated.join('\n');
    return { text: newText, newIds, staleEntries };
}

// ---------- one-off test commands ----------

type ModelTestProvider = 'anthropic' | 'openai' | 'google';

function isModelTestProvider(
    value: string | undefined
): value is ModelTestProvider {
    return value === 'anthropic' || value === 'openai' || value === 'google';
}

function errorShape(e: unknown): Record<string, unknown> {
    const raw =
        e && typeof e === 'object'
            ? (e as Record<string, unknown>)
            : { message: String(e) };
    return {
        name: raw.name,
        message: raw.message,
        status: raw.status,
        code: raw.code,
        type: raw.type,
        error: raw.error,
    };
}

async function printStep(
    label: string,
    fn: () => Promise<unknown>
): Promise<void> {
    console.log(`\n--- ${label} ---`);
    try {
        const result = await fn();
        console.log(JSON.stringify(result, null, 2));
    } catch (e) {
        console.log(JSON.stringify(errorShape(e), null, 2));
    }
}

async function modelTest(
    provider: ModelTestProvider,
    model: string
): Promise<void> {
    if (provider === 'anthropic') {
        const key = process.env.ANTHROPIC_API_KEY;
        if (!key) throw new Error('ANTHROPIC_API_KEY missing from .env');
        const client = new Anthropic({ apiKey: key });
        await printStep(`Anthropic models.retrieve("${model}")`, () =>
            client.models.retrieve(model)
        );
        await printStep(
            `Anthropic messages.create("${model}", max_tokens=1)`,
            () =>
                client.messages.create({
                    model,
                    max_tokens: 1,
                    messages: [{ role: 'user', content: 'a' }],
                })
        );
        return;
    }

    if (provider === 'openai') {
        const key = process.env.OPENAI_API_KEY;
        if (!key) throw new Error('OPENAI_API_KEY missing from .env');
        const client = new OpenAI({ apiKey: key });
        await printStep(`OpenAI models.retrieve("${model}")`, () =>
            client.models.retrieve(model)
        );
        await printStep(
            `OpenAI responses.create("${model}", max_output_tokens=16)`,
            () =>
                client.responses.create({
                    model,
                    input: 'a',
                    max_output_tokens: 16,
                })
        );
        return;
    }

    const key = process.env.GOOGLE_API_KEY;
    if (!key) throw new Error('GOOGLE_API_KEY missing from .env');
    const client = new GoogleGenAI({ apiKey: key });
    await printStep(`Google models.get("${model}")`, () =>
        client.models.get({ model })
    );
    await printStep(
        `Google generateContent("${model}", maxOutputTokens=1)`,
        () =>
            client.models.generateContent({
                model,
                contents: 'a',
                config: { maxOutputTokens: 1 },
            })
    );
}

async function retrieveTest(): Promise<void> {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;
    const googleKey = process.env.GOOGLE_API_KEY;
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY missing from .env');
    if (!openaiKey) throw new Error('OPENAI_API_KEY missing from .env');
    if (!googleKey) throw new Error('GOOGLE_API_KEY missing from .env');
    if (!openrouterKey) throw new Error('OPENROUTER_API_KEY missing from .env');

    const a = new Anthropic({ apiKey: anthropicKey });
    const o = new OpenAI({ apiKey: openaiKey });
    const g = new GoogleGenAI({ apiKey: googleKey });

    console.log('--- Anthropic models.retrieve("claude-opus-4-7") ---');
    const aModel = await a.models.retrieve('claude-opus-4-7');
    console.log(JSON.stringify(aModel, null, 2));

    console.log('\n--- OpenAI models.retrieve("gpt-5.5-pro") ---');
    const oModel = await o.models.retrieve('gpt-5.5-pro');
    console.log(JSON.stringify(oModel, null, 2));

    console.log('\n--- Google models.get("gemini-2.5-flash") ---');
    const gModel = await g.models.get({ model: 'gemini-2.5-flash' });
    console.log(JSON.stringify(gModel, null, 2));
}

// ---------- main ----------

async function main(): Promise<void> {
    if (RETRIEVE_TEST) {
        await retrieveTest();
        return;
    }
    if (MODEL_TEST_IDX >= 0) {
        if (!isModelTestProvider(MODEL_TEST_PROVIDER) || !MODEL_TEST_ID) {
            throw new Error(
                'Usage: bun scripts/update-model-list.ts --model-test <anthropic|openai|google> <model-id>'
            );
        }
        await modelTest(MODEL_TEST_PROVIDER, MODEL_TEST_ID);
        return;
    }
    if (SCRAPE_TEST_ID) {
        await runScrapeTest(
            SCRAPE_TEST_ID,
            scrapeOpenAIDocsRaw,
            parseOpenAIDoc
        );
        return;
    }
    if (GOOGLE_SCRAPE_TEST_ID) {
        await runScrapeTest(
            GOOGLE_SCRAPE_TEST_ID,
            scrapeGoogleDocsRaw,
            parseGoogleDoc
        );
        return;
    }

    const openrouter = NEEDS_OPENROUTER
        ? await fetchOpenRouterIndex()
        : undefined;

    let anthropic: DerivedModel[] | undefined;
    let openaiResult: OpenAIPipelineResult | undefined;
    let googleResult: GooglePipelineResult | undefined;

    if (RUN_ANTHROPIC) {
        anthropic = await fetchAnthropic();
        if (VERBOSE) {
            printAnthropicSummary('Anthropic', anthropic);
        } else {
            console.log(`Got ${anthropic.length} models from Anthropic`);
        }
        printAnthropicWarnings(anthropic);

        await emitAndMaybeWrite(
            'anthropic.ts',
            emitProviderFile('anthropic', 'Anthropic', anthropic)
        );
    }

    if (RUN_OPENAI) {
        openaiResult = await pipelineOpenAI(openrouter!);
        if (VERBOSE) {
            printOpenAIPipeline(openaiResult);
        } else {
            console.log(
                `Got ${openaiResult.models.length} models from OpenAI (${openaiResult.skipped.length} skipped)`
            );
        }
        printOpenAIWarnings(openaiResult);

        await emitAndMaybeWrite(
            'openai.ts',
            emitProviderFile('openai', 'OpenAI', openaiResult.models)
        );
    }

    if (RUN_GOOGLE) {
        googleResult = await pipelineGoogle(openrouter!);
        printGooglePipeline(googleResult);
        printGoogleWarnings(googleResult);

        await emitAndMaybeWrite(
            'google.ts',
            emitProviderFile('google', 'Google', googleResult.models)
        );
    }

    const tiersPath = resolve(MODELS_DIR, 'tiers.ts');
    let tiersText = await Bun.file(tiersPath).text();
    const newTiersIds: string[] = [];
    const staleByProvider: Array<{
        provider: string;
        entries: Array<{ id: string; tier: string }>;
    }> = [];

    const tiersUpdates: Array<{
        provider: string;
        comment: string;
        ids: string[] | undefined;
    }> = [
        {
            provider: 'anthropic',
            comment: '// anthropic',
            ids: anthropic?.map((m) => m.id),
        },
        {
            provider: 'openai',
            comment: '// openai',
            ids: openaiResult?.models.map((m) => m.id),
        },
        {
            provider: 'google',
            comment: '// google',
            ids: googleResult?.models.map((m) => m.id),
        },
    ];

    for (const u of tiersUpdates) {
        if (!u.ids) continue;
        const r = updateTiersFile(tiersText, u.comment, u.ids);
        tiersText = r.text;
        newTiersIds.push(...r.newIds);
        if (r.staleEntries.length > 0) {
            staleByProvider.push({
                provider: u.provider,
                entries: r.staleEntries,
            });
        }
    }

    const tiersChanged = newTiersIds.length > 0;
    if (newTiersIds.length > 0) {
        console.log(
            `\nAdding ${newTiersIds.length} new id(s) to tiers.ts as 'legacy':`
        );
        for (const id of newTiersIds) console.log(`   - ${id}`);
    }

    const totalStale = staleByProvider.reduce(
        (n, p) => n + p.entries.length,
        0
    );
    if (totalStale > 0) {
        console.log(
            `\n⚠ ${totalStale} stale tier entry/entries — model not in current provider file, consider removing from tiers.ts:`
        );
        for (const { provider, entries } of staleByProvider) {
            for (const e of entries) {
                console.log(`   - [${provider}] ${e.id} (${e.tier})`);
            }
        }
    }
    if (WRITE && tiersChanged) {
        await Bun.write(tiersPath, tiersText);
        console.log(
            newTiersIds.length > 0
                ? `✓ wrote tiers.ts (+${newTiersIds.length} entries)`
                : '✓ wrote tiers.ts (re-sorted)'
        );
    }

    if (!WRITE) {
        console.log('\n(dry run — pass --write to clobber provider files)');
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
