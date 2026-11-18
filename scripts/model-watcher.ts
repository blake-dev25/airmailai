import { assertKnownFlags } from './cli-flags';
import { notify, updateEmbeds, watcherEmbeds } from './model-list/discord';
import {
    LOCAL_MODELS_FILE,
    LOCAL_STATE_DIR,
    SNAPSHOT_PREFIX,
    SNAPSHOT_RETENTION_MS,
    resolveAwsConfig,
} from './model-list/env';
import {
    localModelsFileTarget,
    s3ModelsFileTarget,
} from './model-list/models-file';
import { FsStateStore, S3StateStore } from './model-list/state-store';
import { syncLocalTiersFile } from './model-list/tiers-file';
import { assertUpdateSucceeded, runUpdate } from './model-list/update';
import {
    acknowledgeModels,
    providersWithNewModels,
    runWatcher,
} from './model-list/watcher';

const args = process.argv.slice(2);
const LOCAL = args.includes('--local');
const UPDATE = args.includes('--update');

async function main(): Promise<void> {
    assertKnownFlags(args, ['--local', '--update']);
    const aws = resolveAwsConfig(LOCAL);
    const store = aws
        ? new S3StateStore(aws.stateBucket)
        : new FsStateStore(LOCAL_STATE_DIR);
    console.log(
        aws
            ? `AWS mode (profile ${process.env.AWS_PROFILE}): state in s3://${aws.stateBucket}/`
            : `local mode: state in ${LOCAL_STATE_DIR}`
    );

    const report = await runWatcher(store);
    const providers = providersWithNewModels(report);
    if (providers.length > 0 && UPDATE) {
        const targets = [localModelsFileTarget(LOCAL_MODELS_FILE)];
        if (aws) {
            targets.push(s3ModelsFileTarget(aws.wwwBucket, aws.distributionId));
        }
        const update = await runUpdate(
            {
                providers: new Set(providers),
                write: true,
                verbose: false,
                refreshDocs: false,
                refreshProbes: false,
                retryNon200: false,
                newIds: report.newIds,
            },
            { store, targets }
        );
        await acknowledgeModels(
            store,
            report.observedIds,
            update.outcomes
                .filter((outcome) => outcome.status === 'updated')
                .map((outcome) => outcome.provider)
        );
        await notify(watcherEmbeds(report));
        await notify(updateEmbeds(update, 'watcher --update'));
        await syncLocalTiersFile(update.file, true);
        if (store instanceof FsStateStore) {
            const pruned = await store.pruneOlderThan(
                SNAPSHOT_PREFIX,
                SNAPSHOT_RETENTION_MS
            );
            if (pruned > 0) console.log(`pruned ${pruned} expired snapshot(s)`);
        }
        assertUpdateSucceeded(update);
    } else if (providers.length > 0) {
        console.log(
            `\nnew models found - publish with: bun scripts/update-model-list.ts --write ${providers.map((p) => `--${p}`).join(' ')}`
        );
    }
    if (!UPDATE || providers.length === 0) await notify(watcherEmbeds(report));

    const errors = Object.entries(report.errors);
    if (errors.length > 0) {
        throw new Error(
            `${errors.length} provider fetch(es) failed: ${errors.map(([p]) => p).join(', ')}`
        );
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
