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
import { ANTHROPIC_OVERRIDES } from './overrides';

export async function fetchAnthropic(): Promise<DerivedModel[]> {
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
    if (o.thinking) {
        const adaptive = o.thinking.adaptive ?? d.thinking?.adaptive;
        d.thinking = {
            levels: sortLevels(o.thinking.levels),
            defaultLevel: o.thinking.defaultLevel,
            ...(adaptive ? { adaptive } : {}),
        };
    }
    if (o.thinkingExtraLevels && d.thinking) {
        d.thinking.levels = sortLevels([
            ...d.thinking.levels,
            ...o.thinkingExtraLevels,
        ]);
    }
    if (o.tools) d.tools = o.tools;
    return d;
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
}
