// *** Fetches each first-party provider's official model list and emits the
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
    parseAnthropicOverview,
    printAnthropicSummary,
    printAnthropicWarnings,
    scrapeAnthropicOverviewRaw,
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
    ANTHROPIC_TOOLS_LATEST,
    GOOGLE_OVERRIDES,
    OPENAI_OVERRIDES,
    type ModelOverride,
    applyOverride,
} from './update-model-list/overrides';
import { updateTiersFile } from './update-model-list/tiers';

function overridesForProvider(provider: string): Record<string, ModelOverride> {
    if (provider === 'anthropic') return ANTHROPIC_OVERRIDES;
    if (provider === 'openai') return OPENAI_OVERRIDES;
    if (provider === 'google') return GOOGLE_OVERRIDES;
    return {};
}

function reapplyOverrides(provider: string, models: DerivedModel[]): void {
    const overrides = overridesForProvider(provider);
    const byAliasOrId = new Map<string, ModelOverride>();
    for (const [key, entry] of Object.entries(overrides)) {
        byAliasOrId.set(key, entry);
        if (entry.idAlias) byAliasOrId.set(entry.idAlias, entry);
    }
    for (const m of models) {
        const o = byAliasOrId.get(m.id);
        if (o) applyOverride(m, o);
        if (provider === 'anthropic' && !m.tools) {
            m.tools = ANTHROPIC_TOOLS_LATEST;
        }
    }
}

const WRITE = process.argv.includes('--write');
const VERBOSE = process.argv.includes('--verbose');
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
const ANTHROPIC_SCRAPE_TEST = process.argv.includes('--anthropic-scrape-test');

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
        reapplyOverrides(provider, models);
        const content = emitProviderFile(provider, providerName, models);
        const path = resolve(MODELS_DIR, `${provider}.ts`);
        await Bun.write(path, content);
        console.log(`✓ wrote ${content.length} bytes to ${path}`);
    }

    const tiersPath = resolve(MODELS_DIR, 'tiers.ts');
    const originalTiersText = await Bun.file(tiersPath).text();
    let tiersText = originalTiersText;
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

    if (tiersText !== originalTiersText) {
        await Bun.write(tiersPath, tiersText);
        console.log(`✓ wrote ${tiersPath}`);
    } else {
        console.log('tiers.ts unchanged');
    }
}

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

async function main(): Promise<void> {
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
    if (ANTHROPIC_SCRAPE_TEST) {
        await runScrapeTest(
            'models-overview',
            () => scrapeAnthropicOverviewRaw(),
            (_id, md) => Object.fromEntries(parseAnthropicOverview(md))
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
    const originalTiersText = await Bun.file(tiersPath).text();
    let tiersText = originalTiersText;
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

    const tiersChanged = tiersText !== originalTiersText;
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
