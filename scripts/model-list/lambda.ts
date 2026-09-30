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

async function invokeUpdater(
    providers: Provider[],
    observedIds: ObservedModelIds
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
                    observedIds,
                    reason: 'watcher found new models',
                })
            ),
        })
    );
    console.log(`invoked ${functionName} for ${providers.join(', ')}`);
}

export async function watcherHandler(): Promise<unknown> {
    try {
        const { store } = await getRuntime();
        const report = await runWatcher(store);
        const providers = providersWithNewModels(report);
        if (providers.length > 0)
            await invokeUpdater(providers, report.observedIds);
        await notify(watcherEmbeds(report));
        if (Object.keys(report.errors).length > 0) {
            throw new Error(
                `Provider model fetches failed: ${Object.keys(report.errors).join(', ')}`
            );
        }
        return {
            ok: Object.keys(report.errors).length === 0,
            triggered: providers,
            ...report,
        };
    } catch (e) {
        await notifyCrash('model-list watcher', e);
        throw e;
    }
}

interface UpdaterEvent {
    providers?: unknown;
    reason?: unknown;
    observedIds?: unknown;
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

export async function updaterHandler(
    event: UpdaterEvent = {}
): Promise<unknown> {
    try {
        const { aws, store } = await getRuntime();
        const providers = parseProviders(event);
        const observedIds =
            event.observedIds === undefined
                ? {}
                : parseObservedModelIds(
                      event.observedIds,
                      'updater event.observedIds'
                  );
        const reason =
            typeof event.reason === 'string' ? event.reason : 'manual invoke';
        const report = await runUpdate(
            {
                providers,
                write: true,
                verbose: false,
                refreshDocs: false,
                refreshProbes: false,
                retryNon200: false,
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
        assertUpdateSucceeded(report);
        return {
            ok: true,
            ...report,
        };
    } catch (e) {
        await notifyCrash('model-list updater', e);
        throw e;
    }
}
