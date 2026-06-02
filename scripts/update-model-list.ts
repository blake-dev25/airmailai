// Fetches each first-party provider's official model list and emits the
// matching packages/courierai_web/src/lib/models/<provider>.ts file.
//
// OpenRouter is metadata enrichment only. It never decides first-party
// availability; provider APIs do that, with targeted official-doc scraping
// filling gaps where APIs/OpenRouter do not expose the fields CourierAI needs.
//
// Run dry (prints, writes JSON snapshots to scripts/.tmp/ but does not touch
// packages/courierai_web/src/lib/models/):
//     bun scripts/update-model-list.ts
// Run with writes (also still writes snapshots):
//     bun scripts/update-model-list.ts --write
// Re-emit provider files from saved snapshots, skipping all API/scrape/probe
// work. Accepts one or more snapshot paths; only the matching provider
// sections of tiers.ts are touched:
//     bun scripts/update-model-list.ts --write-from-file scripts/.tmp/run_anthropic_<ts>.json [more...]
//
// Bun auto-loads .env at the repo root.

import { resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import {
    fetchAnthropic,
    printAnthropicSummary,
    printAnthropicWarnings,
} from './update-model-list/anthropic';
import {
    type OpenAIPipelineResult,
    parseOpenAIDoc,
    pipelineOpenAI,
    printOpenAIPipeline,
    printOpenAIWarnings,
    scrapeOpenAIDocsRaw,
} from './update-model-list/openai';
import {
    type GooglePipelineResult,
    parseGoogleDoc,
    pipelineGoogle,
    printGooglePipeline,
    printGoogleWarnings,
    scrapeGoogleDocsRaw,
} from './update-model-list/google';
import {
    type DerivedModel,
    type Snapshot,
    MODELS_DIR,
    emitAndMaybeWrite,
    emitProviderFile,
    fetchOpenRouterIndex,
    loadSnapshot,
    runScrapeTest,
    writeSnapshot,
} from './update-model-list/shared';
import {
    ANTHROPIC_OVERRIDES,
    GOOGLE_OVERRIDES,
    OPENAI_OVERRIDES,
    type ModelOverride,
} from './update-model-list/overrides';
import { sortLevels } from './update-model-list/shared';
import { updateTiersFile } from './update-model-list/tiers';

// Snapshots are output-side state - they capture what the provider+overrides
// pipeline emitted at one point in time. On --write-from-file replay we
// re-overlay overrides.ts so editing it and rerunning picks the changes up
// without burning API calls. Stomp semantics: any field set on the override
// wins over what the snapshot stored.
function overridesForProvider(provider: string): Record<string, ModelOverride> {
    if (provider === 'anthropic') return ANTHROPIC_OVERRIDES;
    if (provider === 'openai') return OPENAI_OVERRIDES;
    if (provider === 'google') return GOOGLE_OVERRIDES;
    return {};
}

function reapplyOverrides(provider: string, models: DerivedModel[]): void {
    const overrides = overridesForProvider(provider);
    // Build a reverse lookup so models stored under their aliased id (e.g.
    // 'claude-haiku-4-5') still find the override entry keyed by the
    // provider's canonical id ('claude-haiku-4-5-20251001' with idAlias).
    const byAliasOrId = new Map<string, ModelOverride>();
    for (const [key, entry] of Object.entries(overrides)) {
        byAliasOrId.set(key, entry);
        if (entry.idAlias) byAliasOrId.set(entry.idAlias, entry);
    }
    for (const m of models) {
        const o = byAliasOrId.get(m.id);
        if (!o) continue;
        if (o.idAlias) m.id = o.idAlias;
        if (o.name !== undefined) m.name = o.name;
        if (o.contextWindow !== undefined) m.contextWindow = o.contextWindow;
        if (o.maxOutputTokens !== undefined)
            m.maxOutputTokens = o.maxOutputTokens;
        if (o.temperatureMax !== undefined) m.temperatureMax = o.temperatureMax;
        if (o.defaultTemperature !== undefined)
            m.defaultTemperature = o.defaultTemperature;
        if (o.knowledgeCutoff !== undefined)
            m.knowledgeCutoff = o.knowledgeCutoff;
        if (o.thinking) {
            m.thinking = {
                levels: sortLevels(o.thinking.levels),
                defaultLevel: o.thinking.defaultLevel,
                ...(m.thinking?.adaptive
                    ? { adaptive: m.thinking.adaptive }
                    : {}),
            };
        }
        if (o.thinkingExtraLevels && m.thinking) {
            m.thinking.levels = sortLevels([
                ...m.thinking.levels,
                ...o.thinkingExtraLevels,
            ]);
        }
        if (o.tools) m.tools = o.tools;
    }
}

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

const WRITE_FROM_FILE_IDX = process.argv.indexOf('--write-from-file');
const WRITE_FROM_FILE_PATHS: string[] = [];
if (WRITE_FROM_FILE_IDX >= 0) {
    for (let i = WRITE_FROM_FILE_IDX + 1; i < process.argv.length; i++) {
        const arg = process.argv[i];
        if (arg.startsWith('--')) break;
        WRITE_FROM_FILE_PATHS.push(arg);
    }
}

async function writeFromFiles(paths: string[]): Promise<void> {
    const loaded: Snapshot[] = [];
    const seenProviders = new Set<string>();
    for (const p of paths) {
        const snap = await loadSnapshot(p);
        if (seenProviders.has(snap.provider)) {
            throw new Error(
                `Multiple snapshots loaded for provider "${snap.provider}"`
            );
        }
        seenProviders.add(snap.provider);
        console.log(
            `loaded ${snap.provider} snapshot from ${p} (${snap.models.length} models, generated ${snap.generatedAt})`
        );
        loaded.push(snap);
    }

    for (const { provider, providerName, models } of loaded) {
        // Re-apply overrides on top of the snapshot so edits to overrides.ts
        // (e.g. adding tools or pinning a knowledgeCutoff for a freshly
        // released model) land without re-running the full API pipeline.
        reapplyOverrides(provider, models);
        const content = emitProviderFile(provider, providerName, models);
        const path = resolve(MODELS_DIR, `${provider}.ts`);
        await Bun.write(path, content);
        console.log(`✓ wrote ${content.length} bytes to ${path}`);
    }

    const tiersPath = resolve(MODELS_DIR, 'tiers.ts');
    let tiersText = await Bun.file(tiersPath).text();
    const newTiersIds: string[] = [];
    const staleByProvider: Array<{
        provider: string;
        entries: Array<{ id: string; tier: string }>;
    }> = [];

    for (const { provider, models } of loaded) {
        const r = updateTiersFile(
            tiersText,
            `// ${provider}`,
            models.map((m) => m.id)
        );
        tiersText = r.text;
        newTiersIds.push(...r.newIds);
        if (r.staleEntries.length > 0) {
            staleByProvider.push({ provider, entries: r.staleEntries });
        }
    }

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
            `\n⚠ ${totalStale} stale tier entry/entries - model not in current provider file, consider removing from tiers.ts:`
        );
        for (const { provider, entries } of staleByProvider) {
            for (const e of entries) {
                console.log(`   - [${provider}] ${e.id} (${e.tier})`);
            }
        }
    }

    await Bun.write(tiersPath, tiersText);
    console.log(`✓ wrote ${tiersPath}`);
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
    if (WRITE_FROM_FILE_IDX >= 0) {
        if (WRITE_FROM_FILE_PATHS.length === 0) {
            throw new Error('--write-from-file requires at least one path');
        }
        if (PROVIDER_FLAGS.size > 0) {
            throw new Error(
                '--write-from-file cannot be combined with --anthropic/--openai/--google'
            );
        }
        if (WRITE) {
            throw new Error(
                '--write-from-file already writes; do not pass --write'
            );
        }
        await writeFromFiles(WRITE_FROM_FILE_PATHS);
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

        await writeSnapshot('anthropic', 'Anthropic', anthropic);
        await emitAndMaybeWrite(
            'anthropic.ts',
            emitProviderFile('anthropic', 'Anthropic', anthropic),
            { write: WRITE, verbose: VERBOSE }
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

        await writeSnapshot('openai', 'OpenAI', openaiResult.models);
        await emitAndMaybeWrite(
            'openai.ts',
            emitProviderFile('openai', 'OpenAI', openaiResult.models),
            { write: WRITE, verbose: VERBOSE }
        );
    }

    if (RUN_GOOGLE) {
        googleResult = await pipelineGoogle(openrouter!);
        printGooglePipeline(googleResult, VERBOSE);
        printGoogleWarnings(googleResult);

        await writeSnapshot('google', 'Google', googleResult.models);
        await emitAndMaybeWrite(
            'google.ts',
            emitProviderFile('google', 'Google', googleResult.models),
            { write: WRITE, verbose: VERBOSE }
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
            `\n⚠ ${totalStale} stale tier entry/entries - model not in current provider file, consider removing from tiers.ts:`
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
        console.log('\n(dry run - pass --write to clobber provider files)');
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
