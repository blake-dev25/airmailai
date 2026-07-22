import Anthropic from '@anthropic-ai/sdk';
import {
    type DerivedModel,
    type DerivedThinking,
    type ModelProbeResult,
    type ThinkingLevel,
    MODEL_PROBE_DELAY_MS,
    pollWithDelay,
    printIdList,
    printModelRow,
    probeErrorCode,
    sortLevels,
} from './shared';
import {
    ANTHROPIC_OVERRIDES,
    ANTHROPIC_TOOLS_LATEST,
    applyOverride,
    staleOverrideIds,
} from './overrides';

const ANTHROPIC_MODELS_OVERVIEW_URL =
    'https://platform.claude.com/docs/en/about-claude/models/overview.md';
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

// *** The overview page is served as markdown directly - no turndown pass
// like the OpenAI/Google scrapers (turndown would mangle the pipe tables).
export async function scrapeAnthropicOverviewRaw(): Promise<{
    url: string;
    status: number;
    markdown: string | null;
}> {
    const res = await fetch(ANTHROPIC_MODELS_OVERVIEW_URL);
    return {
        url: ANTHROPIC_MODELS_OVERVIEW_URL,
        status: res.status,
        markdown: res.ok ? await res.text() : null,
    };
}

export function parseAnthropicOverview(md: string): Map<string, string> {
    const cutoffs = new Map<string, string>();
    let ids: string[] = [];
    let aliases: string[] = [];
    for (const line of md.split('\n')) {
        if (!/^\s*\|/.test(line)) continue;
        const cells = line.split('|').map((c) => c.trim());
        const label = cells[1]?.replace(/\*\*/g, '').trim();
        const values = cells.slice(2, -1);
        if (label === 'Claude API ID') {
            ids = values;
            aliases = [];
        } else if (label === 'Claude API alias') {
            aliases = values;
        } else if (label === 'Reliable knowledge cutoff') {
            values.forEach((v, i) => {
                const cutoff = v.match(/[A-Z][a-z]{2} \d{4}/)?.[0];
                if (!cutoff) return;
                if (ids[i]) cutoffs.set(ids[i], cutoff);
                if (aliases[i]) cutoffs.set(aliases[i], cutoff);
            });
        }
    }
    return cutoffs;
}

async function fetchAnthropicCutoffs(): Promise<Map<string, string>> {
    console.log('scraping Anthropic models overview for knowledge cutoffs');
    try {
        const { status, markdown } = await scrapeAnthropicOverviewRaw();
        if (!markdown) {
            console.log(`⚠ overview scrape failed (HTTP ${status})`);
            return new Map();
        }
        const cutoffs = parseAnthropicOverview(markdown);
        if (cutoffs.size === 0) {
            console.log(
                '⚠ overview page parsed to 0 cutoffs - page layout may have changed'
            );
        } else {
            console.log(`got ${cutoffs.size} cutoff entries from overview`);
        }
        return cutoffs;
    } catch (e) {
        console.log(`⚠ overview scrape failed: ${(e as Error).message}`);
        return new Map();
    }
}

export async function fetchAnthropic(): Promise<DerivedModel[]> {
    console.log('starting Anthropic polling');
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY missing from .env');
    const client = new Anthropic({ apiKey: key });

    await checkAnthropicToolVersions();
    const cutoffs = await fetchAnthropicCutoffs();
    const out: DerivedModel[] = [];
    for await (const m of client.models.list({ limit: 1000 })) {
        const d = deriveAnthropic(m);
        const o = ANTHROPIC_OVERRIDES[d.id];
        if (o) applyOverride(d, o);
        if (!d.knowledgeCutoff) {
            const cutoff = cutoffs.get(d.id);
            if (cutoff) d.knowledgeCutoff = cutoff;
        }
        out.push(d);
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
