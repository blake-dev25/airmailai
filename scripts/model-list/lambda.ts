import { notify, notifyCrash, updateEmbeds, watcherEmbeds } from './discord';
import {
    type AwsConfig,
    loadSecretsFromSsm,
    requireEnv,
    resolveAwsConfig,
} from './env';
import { s3ModelsFileTarget } from './models-file';
import type { Provider } from './shared';
import { S3StateStore } from './state-store';
import {
    ALL_PROVIDERS,
    assertUpdateSucceeded,
    isProvider,
    runUpdate,
} from './update';
import {
    acknowledgeModels,
    type ObservedModelIds,
    parseObservedModelIds,
    providersWithNewModels,
    runWatcher,
    type WatcherReport,
} from './watcher';

interface Runtime {
    aws: AwsConfig;
    store: S3StateStore;
}

let runtime: Promise<Runtime> | undefined;

function getRuntime(): Promise<Runtime> {
    runtime ??= (async () => {
        await loadSecretsFromSsm();
        const aws = resolveAwsConfig(false);
        if (!aws) throw new Error('Lambda environment is missing AWS config');
        return { aws, store: new S3StateStore(aws.stateBucket) };
    })().catch((error) => {
        runtime = undefined;
        throw error;
    });
    return runtime;
}

interface LambdaContext {
    getRemainingTimeInMillis(): number;
}

const WATCHER_POLL_RETRY_DELAYS_MS = [60_000, 120_000];
const DEADLINE_WARNING_MS = 10_000;

async function withDeadlineWarning<T>(
    what: string,
    context: LambdaContext | undefined,
    run: () => Promise<T>
): Promise<T> {
    const timer =
        context &&
        setTimeout(
            () =>
                void notifyCrash(
                    what,
                    new Error(
                        'Lambda timeout is imminent - the invocation is about to be killed before it can finish or report'
                    )
                ),
            context.getRemainingTimeInMillis() - DEADLINE_WARNING_MS
        );
    try {
        return await run();
    } finally {
        clearTimeout(timer);
    }
}

async function invokeUpdater(
    providers: Provider[],
    report: WatcherReport
): Promise<void> {
    const functionName = requireEnv('AIRMAILAI_MODEL_LIST_UPDATER_FUNCTION');
    const { LambdaClient, InvokeCommand } =
        await import('@aws-sdk/client-lambda');
    await new LambdaClient({}).send(
        new InvokeCommand({
            FunctionName: functionName,
            InvocationType: 'Event',
            Payload: Buffer.from(
                JSON.stringify({
                    providers,
                    observedIds: report.observedIds,
                    newIds: report.newIds,
                    reason: 'watcher found new models',
                })
            ),
        })
    );
    console.log(`invoked ${functionName} for ${providers.join(', ')}`);
}

export async function watcherHandler(
    _event?: unknown,
    context?: LambdaContext
): Promise<unknown> {
    const what = 'model-list watcher';
    const { report, providers } = await withDeadlineWarning(
        what,
        context,
        async () => {
            try {
                const { store } = await getRuntime();
                const report = await runWatcher(
                    store,
                    WATCHER_POLL_RETRY_DELAYS_MS
                );
                const providers = providersWithNewModels(report);
                if (providers.length > 0)
                    await invokeUpdater(providers, report);
                await notify(watcherEmbeds(report));
                return { report, providers };
            } catch (e) {
                await notifyCrash(what, e);
                throw e;
            }
        }
    );
    const failed = Object.keys(report.errors);
    if (failed.length > 0) {
        throw new Error(`Provider model fetches failed: ${failed.join(', ')}`);
    }
    return { ok: true, triggered: providers, ...report };
}

interface UpdaterEvent {
    providers?: unknown;
    reason?: unknown;
    observedIds?: unknown;
    newIds?: unknown;
}

function parseProviders(event: UpdaterEvent): Set<Provider> {
    if (event.providers === undefined) return new Set(ALL_PROVIDERS);
    if (!Array.isArray(event.providers) || !event.providers.every(isProvider)) {
        throw new Error(
            `Invalid providers in event: ${JSON.stringify(event.providers)}`
        );
    }
    return new Set(event.providers);
}

function parseEventModelIds(
    event: UpdaterEvent,
    field: 'observedIds' | 'newIds'
): ObservedModelIds {
    const value = event[field];
    return value === undefined
        ? {}
        : parseObservedModelIds(value, `updater event.${field}`);
}

export async function updaterHandler(
    event: UpdaterEvent = {},
    context?: LambdaContext
): Promise<unknown> {
    const what = 'model-list updater';
    const report = await withDeadlineWarning(what, context, async () => {
        try {
            const { aws, store } = await getRuntime();
            const providers = parseProviders(event);
            const observedIds = parseEventModelIds(event, 'observedIds');
            const newIds = parseEventModelIds(event, 'newIds');
            const reason =
                typeof event.reason === 'string'
                    ? event.reason
                    : 'manual invoke';
            const report = await runUpdate(
                {
                    providers,
                    write: true,
                    verbose: false,
                    refreshDocs: false,
                    refreshProbes: false,
                    retryNon200: false,
                    newIds,
                },
                {
                    store,
                    targets: [
                        s3ModelsFileTarget(aws.wwwBucket, aws.distributionId),
                    ],
                }
            );
            await acknowledgeModels(
                store,
                observedIds,
                report.outcomes
                    .filter((outcome) => outcome.status === 'updated')
                    .map((outcome) => outcome.provider)
            );
            await notify(updateEmbeds(report, `lambda, ${reason}`));
            return report;
        } catch (e) {
            await notifyCrash(what, e);
            throw e;
        }
    });
    assertUpdateSucceeded(report);
    const { file: _file, ...summary } = report;
    return {
        ok: true,
        ...summary,
    };
}
