import { resolve } from 'node:path';
import TurndownService from 'turndown';
import type {
    ModelTools,
    ThinkingLevel,
} from '../../packages/airmailai_web/src/lib/models/types';

export type { ThinkingLevel };

export interface DerivedThinking {
    levels: ThinkingLevel[];
    defaultLevel: ThinkingLevel;
    adaptive?: 'optional' | 'required';
}

export interface DerivedModel {
    id: string;
    name: string;
    contextWindow: number | null;
    maxOutputTokens: number | null;
    knowledgeCutoff?: string;
    thinking?: DerivedThinking;
    thinkingPinned?: boolean;
    temperatureMax?: number;
    defaultTemperature?: number;
    tools?: ModelTools;
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

export interface OpenRouterModelInfo {
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

export interface OpenRouterIndex {
    byProvider: Map<string, Map<string, OpenRouterModelInfo>>;
}

export interface Snapshot {
    provider: string;
    providerName: string;
    generatedAt: string;
    models: DerivedModel[];
}

export type ModelProbeStatus = 'ok' | 'grandfathered' | 'dead';
export interface ModelProbeResult {
    status: ModelProbeStatus;
    code: string;
}

export const MODELS_DIR = resolve(
    import.meta.dir,
    '../../packages/airmailai_web/src/lib/models'
);
export const SNAPSHOT_DIR = resolve(import.meta.dir, '../.tmp');
export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';
export const WEBPAGE_SCRAPE_DELAY_MS = 2000;
export const MODEL_PROBE_DELAY_MS = 2000;

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

export function sortLevels(levels: ThinkingLevel[]): ThinkingLevel[] {
    const set = new Set(levels);
    return LEVEL_ORDER.filter((l) => set.has(l));
}

export function fallbackReasoningThinking(): DerivedThinking {
    return {
        levels: [...FALLBACK_REASONING_LEVELS],
        defaultLevel: 'none',
    };
}

export function stripProviderName(name: string, provider: string): string {
    const prefix = `${provider}: `;
    return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

export function formatKnowledgeCutoff(
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

export function formatThinking(
    m: DerivedModel,
    kind: 'anthropic' | 'default'
): string {
    if (!m.thinking) return 'no thinking';
    if (kind === 'anthropic') {
        return `thinking[${m.thinking.adaptive ?? 'enabled-only'}]: ${m.thinking.levels.join('/')}`;
    }
    return `thinking: ${m.thinking.levels.join('/')} (default ${m.thinking.defaultLevel})`;
}

export function printModelRow(
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

export function printIdList(header: string, ids: string[]): void {
    if (ids.length === 0) return;
    console.log(`\n   ${header}`);
    for (const id of ids) console.log(`   - ${id}`);
}

export function tsString(value: string): string {
    const inner = JSON.stringify(value)
        .slice(1, -1)
        .replace(/\\"/g, '"')
        .replace(/'/g, "\\'");
    return `'${inner}'`;
}

const SAFE_MODEL_ID = /^[A-Za-z0-9._:/~-]+$/;

export function assertSafeModelId(id: string): void {
    if (!SAFE_MODEL_ID.test(id)) {
        throw new Error(`Rejecting unsafe model id: ${JSON.stringify(id)}`);
    }
}

export function emitProviderFile(
    providerId: string,
    providerName: string,
    models: DerivedModel[]
): string {
    const header = `import type { ProviderOption } from './types';

// NOTE FOR LLMS: NEVER MANUALLY MODIFY IDS/NAMES, THEY ARE CORRECT
// This file is automatically written over by scripts/update-model-list.ts, edits will not be saved
export const ${providerId.toUpperCase()}: ProviderOption = {
    id: ${tsString(providerId)},
    name: ${tsString(providerName)},
    models: [
`;
    const body = models.map(emitModelEntry).join('');
    const footer = `    ],
};
`;
    return header + body + footer;
}

function emitModelEntry(m: DerivedModel): string {
    assertSafeModelId(m.id);
    const maxOutputTokens = m.maxOutputTokens ?? 0;
    const defaultMaxTokens =
        maxOutputTokens > 0 ? Math.min(8192, maxOutputTokens) : 8192;
    const lines: string[] = [];
    lines.push('        {');
    lines.push(`            id: ${tsString(m.id)},`);
    lines.push(`            name: ${tsString(m.name)},`);
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
        lines.push(
            `                knowledgeCutoff: ${tsString(m.knowledgeCutoff)},`
        );
    }
    if (m.thinking) {
        lines.push('                thinking: {');
        const lv = m.thinking.levels.map(tsString).join(', ');
        lines.push(`                    levels: [${lv}],`);
        lines.push(
            `                    defaultLevel: ${tsString(m.thinking.defaultLevel)},`
        );
        if (m.thinking.adaptive) {
            lines.push(
                `                    adaptive: ${tsString(m.thinking.adaptive)},`
            );
        }
        lines.push('                },');
    }
    lines.push('            },');
    if (m.tools) {
        const formatToolValue = (v: boolean | string): string =>
            typeof v === 'string' ? tsString(v) : String(v);
        lines.push('            tools: {');
        if (m.tools.webSearch !== undefined) {
            lines.push(
                `                webSearch: ${formatToolValue(m.tools.webSearch)},`
            );
        }
        if (m.tools.webFetch !== undefined) {
            lines.push(
                `                webFetch: ${formatToolValue(m.tools.webFetch)},`
            );
        }
        if (m.tools.codeExecution !== undefined) {
            lines.push(
                `                codeExecution: ${formatToolValue(m.tools.codeExecution)},`
            );
        }
        if (m.tools.searchFetchLinked) {
            lines.push(`                searchFetchLinked: true,`);
        }
        lines.push('            },');
    }
    lines.push('        },');
    return lines.join('\n') + '\n';
}

export async function emitAndMaybeWrite(
    filename: string,
    content: string,
    opts: { write: boolean; verbose: boolean }
): Promise<void> {
    if (opts.verbose) {
        console.log(`\n--- Generated ${filename} ---\n`);
        console.log(content);
    }
    if (opts.write) {
        const path = resolve(MODELS_DIR, filename);
        await Bun.write(path, content);
        console.log(`\n✓ wrote ${content.length} bytes to ${path}`);
    }
}

function snapshotTimestamp(): string {
    return new Date().toISOString().slice(0, 19).replace(/:/g, '-');
}

export async function writeSnapshot(
    provider: string,
    providerName: string,
    models: DerivedModel[]
): Promise<void> {
    const filename = `run_${provider}_${snapshotTimestamp()}.json`;
    const path = resolve(SNAPSHOT_DIR, filename);
    const payload: Snapshot = {
        provider,
        providerName,
        generatedAt: new Date().toISOString(),
        models,
    };
    await Bun.write(path, JSON.stringify(payload, null, 2));
    console.log(`✓ wrote snapshot: ${path}`);
}

export async function loadSnapshot(path: string): Promise<Snapshot> {
    const text = await Bun.file(path).text();
    const data = JSON.parse(text) as Partial<Snapshot>;
    if (
        data.provider !== 'anthropic' &&
        data.provider !== 'openai' &&
        data.provider !== 'google'
    ) {
        throw new Error(
            `${path}: unknown or missing provider "${data.provider}"`
        );
    }
    if (!Array.isArray(data.models)) {
        throw new Error(`${path}: missing models array`);
    }
    if (typeof data.providerName !== 'string') {
        throw new Error(`${path}: missing providerName`);
    }
    return data as Snapshot;
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pollWithDelay<T, R>(
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

export function probeErrorCode(e: unknown): string {
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

const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
});
turndown.remove(['style', 'script', 'noscript', 'iframe']);
turndown.remove((node) => node.nodeName.toLowerCase() === 'svg');

export async function scrapeDocsRaw(
    url: string
): Promise<{ url: string; status: number; markdown: string | null }> {
    const res = await fetch(url);
    if (!res.ok) return { url, status: res.status, markdown: null };
    const html = await res.text();
    return { url, status: res.status, markdown: turndown.turndown(html) };
}

export async function runScrapeTest<T>(
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
        console.log('(no markdown - non-200 response)');
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

export async function fetchOpenRouterIndex(): Promise<OpenRouterIndex> {
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
        const [rawProvider, ...rest] = raw.id.split('/');
        const provider = rawProvider?.replace(/^~/, '');
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

export function findOpenRouter(
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

export function supportsOpenRouterParam(
    info: OpenRouterModelInfo | undefined,
    param: string
): boolean {
    return info?.supportedParams.includes(param) ?? false;
}
