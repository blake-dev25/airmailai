import TurndownService from 'turndown';
import { SAFE_MODEL_ID } from '../../packages/airmailai_web/src/lib/models/modelsFile';
import type {
    FirstPartyProviderId,
    ModelOption,
    ModelParams,
    ModelTools,
    ThinkingLevel,
} from '../../packages/airmailai_web/src/lib/models/types';
import { requireApiKey } from './env';
import { HttpError, httpJson, httpRequest, sleep } from './http';

export type { ThinkingLevel };
export type Provider = FirstPartyProviderId;

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
    shutdownDate?: string;
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

export type ModelProbeStatus = 'ok' | 'grandfathered' | 'dead';
export interface ModelProbeResult {
    status: ModelProbeStatus;
    code: string;
}

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

export function idListWarning(header: string, ids: string[]): string[] {
    if (ids.length === 0) return [];
    return [`${header}\n${ids.map((id) => `   - ${id}`).join('\n')}`];
}

export function assertSafeModelId(id: string): void {
    if (!SAFE_MODEL_ID.test(id)) {
        throw new Error(`Rejecting unsafe model id: ${JSON.stringify(id)}`);
    }
}

function versionSegments(name: string): number[] {
    const token = name.replace(/\([^)]*\)/g, '').match(/\d+(?:\.\d+)*/);
    return token ? token[0].split('.').map(Number) : [0];
}

export function compareModelsByVersion(
    a: { name: string },
    b: { name: string }
): number {
    const av = versionSegments(a.name);
    const bv = versionSegments(b.name);
    const len = Math.max(av.length, bv.length);
    for (let i = 0; i < len; i++) {
        const diff = (bv[i] ?? 0) - (av[i] ?? 0);
        if (diff !== 0) return diff;
    }
    return a.name.localeCompare(b.name);
}

export function toModelOption(m: DerivedModel): ModelOption {
    assertSafeModelId(m.id);
    const maxOutputTokens = m.maxOutputTokens ?? 0;
    const params: ModelParams = {
        contextWindow: m.contextWindow ?? 0,
        maxOutputTokens,
        defaultMaxTokens:
            maxOutputTokens > 0 ? Math.min(8192, maxOutputTokens) : 8192,
    };
    if (m.temperatureMax !== undefined) {
        params.temperatureMax = m.temperatureMax;
        params.defaultTemperature = m.defaultTemperature ?? 1;
    }
    if (m.knowledgeCutoff) params.knowledgeCutoff = m.knowledgeCutoff;
    if (m.thinking) {
        params.thinking = {
            levels: [...m.thinking.levels],
            defaultLevel: m.thinking.defaultLevel,
            ...(m.thinking.adaptive ? { adaptive: m.thinking.adaptive } : {}),
        };
    }
    const option: ModelOption = { id: m.id, name: m.name, params };
    if (m.tools) {
        const tools: ModelTools = {};
        if (m.tools.webSearch !== undefined)
            tools.webSearch = m.tools.webSearch;
        if (m.tools.webFetch !== undefined) tools.webFetch = m.tools.webFetch;
        if (m.tools.codeExecution !== undefined) {
            tools.codeExecution = m.tools.codeExecution;
        }
        if (m.tools.searchFetchLinked) tools.searchFetchLinked = true;
        option.tools = tools;
    }
    return option;
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

export function printPollingCacheSummary(
    label: string,
    cachedCodes: string[],
    requests: number,
    delayMs: number
): void {
    const cached200 = cachedCodes.filter((code) => code === '200').length;
    console.log(
        `starting ${label} (${cached200} cached 200, ${cachedCodes.length - cached200} cached non-200, ${requests} requests, ${delayMs / 1000}s spacing)`
    );
}

export function probeFailureCode(e: unknown): string {
    return e instanceof HttpError ? String(e.status) : 'error';
}

export async function printStep(
    label: string,
    fn: () => Promise<unknown>
): Promise<void> {
    console.log(`\n--- ${label} ---`);
    try {
        const result = await fn();
        console.log(JSON.stringify(result, null, 2));
    } catch (e) {
        if (e instanceof HttpError) {
            console.log(`HTTP ${e.status}`);
            console.log(e.body);
        } else {
            console.log(String(e));
        }
    }
}

const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
});
turndown.remove(['style', 'script', 'noscript', 'iframe']);
turndown.remove((node) => node.nodeName.toLowerCase() === 'svg');

export interface ScrapeResult {
    url: string;
    status: number;
    markdown: string | null;
}

export async function scrapeDocsRaw(url: string): Promise<ScrapeResult> {
    const { status, text } = await httpRequest({ url, label: url });
    if (status < 200 || status >= 300) return { url, status, markdown: null };
    return { url, status, markdown: turndown.turndown(text) };
}

export async function scrapeMarkdownRaw(url: string): Promise<ScrapeResult> {
    const { status, text } = await httpRequest({ url, label: url });
    if (status < 200 || status >= 300) return { url, status, markdown: null };
    return { url, status, markdown: text };
}

export async function runScrapeTest<T>(
    id: string,
    fetcher: (id: string) => Promise<ScrapeResult>,
    parser: (id: string, md: string) => T,
    showMarkdown: boolean
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
    if (showMarkdown) {
        console.log('\n--- markdown ---');
        console.log(markdown);
    }
}

export async function fetchOpenRouterIndex(): Promise<OpenRouterIndex> {
    console.log('starting OpenRouter polling');
    const json = await httpJson<{ data?: OpenRouterRawModel[] }>({
        url: OPENROUTER_URL,
        label: 'OpenRouter /models',
        headers: {
            Authorization: `Bearer ${requireApiKey('OPENROUTER_API_KEY')}`,
        },
    });
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
