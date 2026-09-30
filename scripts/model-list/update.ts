import {
    FIRST_PARTY_PROVIDER_IDS,
    MODELS_FILE_SCHEMA_VERSION,
} from '../../packages/airmailai_web/src/lib/models/modelsFile';
import type {
    ModelOption,
    ModelsFile,
} from '../../packages/airmailai_web/src/lib/models/types';
import {
    anthropicWarnings,
    pipelineAnthropic,
    printAnthropicSummary,
} from './anthropic';
import { DocsCache } from './docs-cache';
import { SNAPSHOT_PREFIX } from './env';
import { googleWarnings, pipelineGoogle, printGooglePipeline } from './google';
import { errorMessage } from './http';
import {
    type ModelsFileTarget,
    emptyModelsFile,
    mergeBaseFiles,
    mergeProviderModels,
    sameProviders,
    validateModelsFile,
} from './models-file';
import { openaiWarnings, pipelineOpenAI, printOpenAIPipeline } from './openai';
import { RETIRED_MODEL_IDS } from './overrides';
import { ProbeCache } from './probe-cache';
import {
    type DerivedModel,
    type OpenRouterIndex,
    type Provider,
    fetchOpenRouterIndex,
    toModelOption,
} from './shared';
import type { StateStore } from './state-store';

export const ALL_PROVIDERS: readonly Provider[] = FIRST_PARTY_PROVIDER_IDS;

export function isProvider(value: unknown): value is Provider {
    return ALL_PROVIDERS.includes(value as Provider);
}

export interface UpdateOptions {
    providers: ReadonlySet<Provider>;
    write: boolean;
    verbose: boolean;
    refreshDocs: boolean;
    refreshProbes: boolean;
    retryNon200: boolean;
}

export interface UpdateContext {
    store: StateStore;
    targets: ModelsFileTarget[];
}

export interface ProviderOutcome {
    provider: Provider;
    status: 'updated' | 'failed';
    error?: string;
    modelCount: number;
    added: string[];
    changed: string[];
    unlisted: string[];
    warnings: string[];
}

export interface UpdateReport {
    generatedAt: string;
    dryRun: boolean;
    written: string[];
    unchanged: string[];
    outcomes: ProviderOutcome[];
    retired: Partial<Record<Provider, string[]>>;
}

interface LoadedBase {
    merged: ModelsFile;
    existing: Array<ModelsFile | null>;
}

interface PipelineDeps {
    openrouter: OpenRouterIndex | undefined;
    openrouterError: string | undefined;
    docsCache: DocsCache;
    probeCache: ProbeCache;
    verbose: boolean;
}

interface PipelineOutput {
    models: DerivedModel[];
    warnings: string[];
}

function requireOpenRouter(deps: PipelineDeps): OpenRouterIndex {
    if (!deps.openrouter) {
        throw new Error(
            `OpenRouter index unavailable: ${deps.openrouterError ?? 'not fetched'}`
        );
    }
    return deps.openrouter;
}

async function runProviderPipeline(
    provider: Provider,
    deps: PipelineDeps
): Promise<PipelineOutput> {
    if (provider === 'anthropic') {
        const result = await pipelineAnthropic(deps.docsCache, deps.probeCache);
        if (deps.verbose) printAnthropicSummary('Anthropic', result.models);
        else console.log(`Got ${result.models.length} models from Anthropic`);
        return { models: result.models, warnings: anthropicWarnings(result) };
    }
    if (provider === 'openai') {
        const result = await pipelineOpenAI(
            requireOpenRouter(deps),
            deps.docsCache,
            deps.probeCache
        );
        if (deps.verbose) printOpenAIPipeline(result);
        else {
            console.log(
                `Got ${result.models.length} models from OpenAI (${result.skipped.length} skipped)`
            );
        }
        return { models: result.models, warnings: openaiWarnings(result) };
    }
    const result = await pipelineGoogle(
        requireOpenRouter(deps),
        deps.docsCache,
        deps.probeCache
    );
    if (deps.verbose) printGooglePipeline(result);
    else {
        console.log(
            `Got ${result.models.length} models from Google (${result.skipped.length} skipped)`
        );
    }
    return { models: result.models, warnings: googleWarnings(result) };
}

async function loadBase(targets: ModelsFileTarget[]): Promise<LoadedBase> {
    const files: ModelsFile[] = [];
    const existing: Array<ModelsFile | null> = [];
    for (const target of targets) {
        const file = await target.read();
        existing.push(file);
        if (!file) {
            console.log(
                `WARN no models file at ${target.describe()} - treating as empty`
            );
            continue;
        }
        const counts = ALL_PROVIDERS.map(
            (p) => `${p}=${file.providers[p].length}`
        ).join(' ');
        console.log(
            `loaded ${target.describe()} (generated ${file.generatedAt}, ${counts})`
        );
        files.push(file);
    }
    return {
        merged: files.length > 0 ? mergeBaseFiles(files) : emptyModelsFile(),
        existing,
    };
}

async function writeSnapshot(
    store: StateStore,
    provider: Provider,
    models: DerivedModel[]
): Promise<void> {
    const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    const key = `${SNAPSHOT_PREFIX}run_${provider}_${stamp}.json`;
    await store.write(
        key,
        JSON.stringify(
            { provider, generatedAt: new Date().toISOString(), models },
            null,
            2
        )
    );
    console.log(`OK wrote snapshot: ${store.describe(key)}`);
}

function printList(header: string, ids: string[]): void {
    if (ids.length === 0) return;
    console.log(`   ${header}`);
    for (const id of ids) console.log(`   - ${id}`);
}

type PipelineResult =
    { models: ModelOption[]; warnings: string[] } | { error: string };

function prepareUpdate(
    base: ModelsFile,
    results: Map<Provider, PipelineResult>
): {
    file: ModelsFile;
    outcomes: ProviderOutcome[];
    retired: UpdateReport['retired'];
} {
    const providers = {} as ModelsFile['providers'];
    const outcomes: ProviderOutcome[] = [];
    const retired: UpdateReport['retired'] = {};
    for (const provider of ALL_PROVIDERS) {
        const result = results.get(provider);
        const retiredIds = new Set(RETIRED_MODEL_IDS[provider]);
        const fresh = result && 'models' in result ? result.models : [];
        const removed = [
            ...new Set(
                [...base.providers[provider], ...fresh]
                    .filter((model) => retiredIds.has(model.id))
                    .map((model) => model.id)
            ),
        ];
        if (removed.length > 0) retired[provider] = removed;
        const baseModels = base.providers[provider].filter(
            (model) => !retiredIds.has(model.id)
        );
        if (!result || 'error' in result) {
            providers[provider] = baseModels;
            if (result)
                outcomes.push({
                    provider,
                    status: 'failed',
                    error: result.error,
                    modelCount: baseModels.length,
                    added: [],
                    changed: [],
                    unlisted: [],
                    warnings: [],
                });
            continue;
        }
        const merge = mergeProviderModels(
            baseModels,
            fresh.filter((model) => !retiredIds.has(model.id))
        );
        providers[provider] = merge.models;
        outcomes.push({
            provider,
            status: 'updated',
            modelCount: merge.models.length,
            added: merge.added,
            changed: merge.changed,
            unlisted: merge.unlisted,
            warnings: result.warnings,
        });
    }
    const file = validateModelsFile({
        schemaVersion: MODELS_FILE_SCHEMA_VERSION,
        generatedAt: base.generatedAt,
        providers,
    });
    if (!sameProviders(file, base)) file.generatedAt = new Date().toISOString();
    return { file, outcomes, retired };
}

export function assertUpdateSucceeded(report: UpdateReport): void {
    const failed = report.outcomes.filter(
        (outcome) => outcome.status === 'failed'
    );
    if (failed.length > 0) {
        throw new Error(
            `${failed.length} provider pipeline(s) failed: ${failed.map((outcome) => outcome.provider).join(', ')}`
        );
    }
}

export async function runUpdate(
    opts: UpdateOptions,
    ctx: UpdateContext
): Promise<UpdateReport> {
    const cacheOptions = { retryNon200: opts.retryNon200 };
    const docsCache = await DocsCache.load(ctx.store, {
        ...cacheOptions,
        refresh: opts.refreshDocs,
    });
    const probeCache = await ProbeCache.load(ctx.store, {
        ...cacheOptions,
        refresh: opts.refreshProbes,
    });
    const { merged: base, existing } = await loadBase(ctx.targets);

    let openrouter: OpenRouterIndex | undefined;
    let openrouterError: string | undefined;
    if (opts.providers.has('openai') || opts.providers.has('google')) {
        try {
            openrouter = await fetchOpenRouterIndex();
        } catch (e) {
            openrouterError = errorMessage(e);
            console.log(
                `ERROR OpenRouter index fetch failed: ${openrouterError}`
            );
        }
    }
    const deps: PipelineDeps = {
        openrouter,
        openrouterError,
        docsCache,
        probeCache,
        verbose: opts.verbose,
    };

    const results = new Map<Provider, PipelineResult>();
    for (const provider of ALL_PROVIDERS) {
        const baseModels = base.providers[provider];
        if (!opts.providers.has(provider)) continue;
        console.log(`\n=== ${provider} ===`);
        try {
            const { models, warnings } = await runProviderPipeline(
                provider,
                deps
            );
            if (models.length === 0) {
                throw new Error('pipeline derived 0 models');
            }
            await writeSnapshot(ctx.store, provider, models);
            const options = models.map(toModelOption);
            validateModelsFile({
                ...emptyModelsFile(),
                providers: {
                    ...emptyModelsFile().providers,
                    [provider]: options,
                },
            });
            results.set(provider, { models: options, warnings });
        } catch (e) {
            const error = errorMessage(e);
            console.log(
                `\nERROR ${provider} pipeline failed - keeping ${baseModels.length} previously published model(s): ${error}`
            );
            results.set(provider, { error });
        }
    }

    let prepared = prepareUpdate(base, results);
    const written: string[] = [];
    const unchanged: string[] = [];
    console.log();
    if (opts.write) {
        let publicationBase = base;
        let primary = true;
        for (const target of [...ctx.targets].reverse()) {
            const result = await target.update((current) => {
                const latest = current
                    ? mergeBaseFiles(
                          primary
                              ? [publicationBase, current]
                              : [current, publicationBase]
                      )
                    : publicationBase;
                const next = prepareUpdate(latest, results);
                if (primary) prepared = next;
                return next.file;
            });
            if (primary) prepared.file = result.file;
            primary = false;
            publicationBase = result.file;
            if (result.written) {
                written.push(target.describe());
                console.log(`OK wrote ${target.describe()}`);
            } else {
                unchanged.push(target.describe());
                console.log(`unchanged: ${target.describe()}`);
            }
        }
    } else {
        ctx.targets.forEach((target, i) => {
            const current = existing[i];
            if (current && sameProviders(current, prepared.file)) {
                unchanged.push(target.describe());
                console.log(`unchanged: ${target.describe()}`);
            } else written.push(target.describe());
        });
        for (const path of written) console.log(`would write: ${path}`);
    }

    for (const outcome of prepared.outcomes) {
        if (outcome.status === 'failed') continue;
        console.log(
            `\n${outcome.provider}: ${outcome.modelCount} models (${outcome.added.length} added, ${outcome.changed.length} changed, ${outcome.unlisted.length} kept but no longer listed)`
        );
        printList('added:', outcome.added);
        printList('changed:', outcome.changed);
        printList('kept but no longer listed by provider:', outcome.unlisted);
        for (const warning of outcome.warnings)
            console.log(`\n   WARN ${warning}`);
    }
    for (const provider of ALL_PROVIDERS) {
        printList(
            `${provider} explicitly retired:`,
            prepared.retired[provider] ?? []
        );
    }

    return {
        generatedAt: prepared.file.generatedAt,
        dryRun: !opts.write,
        written,
        unchanged,
        outcomes: prepared.outcomes,
        retired: prepared.retired,
    };
}
