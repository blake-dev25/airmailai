import OpenAI from 'openai';
import {
    type DerivedModel,
    type DerivedThinking,
    type ModelProbeResult,
    type OpenRouterIndex,
    type OpenRouterModelInfo,
    type ThinkingLevel,
    MODEL_PROBE_DELAY_MS,
    WEBPAGE_SCRAPE_DELAY_MS,
    fallbackReasoningThinking,
    findOpenRouter,
    formatKnowledgeCutoff,
    pollWithDelay,
    printIdList,
    printModelRow,
    probeErrorCode,
    scrapeDocsRaw,
    sortLevels,
    stripProviderName,
    supportsOpenRouterParam,
} from './shared';
import { OPENAI_OVERRIDES } from './overrides';

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

export async function scrapeOpenAIDocsRaw(id: string) {
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

export function parseOpenAIDoc(id: string, md: string): ScrapedOpenAI {
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

export interface OpenAIPipelineResult {
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
        tools: o?.tools,
        created: raw.created,
        notes,
    };
}

export async function pipelineOpenAI(
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

export function printOpenAIPipeline(r: OpenAIPipelineResult): void {
    console.log(
        `\n=== OpenAI - ${r.models.length} chat models (${r.skipped.length} skipped) ===`
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
        for (const s of r.skipped) console.log(`   - ${s.id} - ${s.reason}`);
    }
}

export function printOpenAIWarnings(r: OpenAIPipelineResult): void {
    printIdList(
        `${r.needsLevels.length} reasoning model(s) have OpenRouter reasoning support but no inferred levels - add to OPENAI_OVERRIDES if desired:`,
        r.needsLevels
    );
    printIdList(
        `${r.missingCutoff.length} model(s) missing knowledgeCutoff - add to OPENAI_OVERRIDES if desired:`,
        r.missingCutoff
    );
}
