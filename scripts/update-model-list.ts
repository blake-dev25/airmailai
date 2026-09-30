import {
    modelTestAnthropic,
    parseAnthropicModelPage,
    scrapeAnthropicModelPageRaw,
} from './model-list/anthropic';
import { notify, updateEmbeds } from './model-list/discord';
import {
    LOCAL_MODELS_FILE,
    LOCAL_STATE_DIR,
    resolveAwsConfig,
} from './model-list/env';
import {
    modelTestGoogle,
    parseGoogleDoc,
    scrapeGoogleDocsRaw,
} from './model-list/google';
import {
    localModelsFileTarget,
    s3ModelsFileTarget,
} from './model-list/models-file';
import {
    modelTestOpenAI,
    parseOpenAIDoc,
    scrapeOpenAIDocsRaw,
} from './model-list/openai';
import { type Provider, runScrapeTest } from './model-list/shared';
import { FsStateStore, S3StateStore } from './model-list/state-store';
import {
    ALL_PROVIDERS,
    assertUpdateSucceeded,
    isProvider,
    runUpdate,
} from './model-list/update';

const args = process.argv.slice(2);
const has = (flag: string): boolean => args.includes(flag);
const valueAfter = (flag: string, offset = 1): string | undefined => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + offset] : undefined;
};

const WRITE = has('--write');
const VERBOSE = has('--verbose');
const LOCAL = has('--local');
const REFRESH_DOCS = has('--refresh-docs');
const REFRESH_PROBES = has('--refresh-probes');
const RETRY_NON_200 = has('--retry-non-200');
const SHOW_MD = has('--show-md');

const providerFlags = ALL_PROVIDERS.filter((p) => has(`--${p}`));
const PROVIDERS = new Set<Provider>(
    providerFlags.length > 0 ? providerFlags : ALL_PROVIDERS
);

async function main(): Promise<void> {
    if (has('--model-test')) {
        const provider = valueAfter('--model-test');
        const model = valueAfter('--model-test', 2);
        if (!isProvider(provider) || !model) {
            throw new Error(
                'Usage: bun scripts/update-model-list.ts --model-test <anthropic|openai|google> <model-id>'
            );
        }
        if (provider === 'anthropic') await modelTestAnthropic(model);
        else if (provider === 'openai') await modelTestOpenAI(model);
        else await modelTestGoogle(model);
        return;
    }
    const openaiScrape = valueAfter('--scrape-test');
    if (openaiScrape) {
        await runScrapeTest(
            openaiScrape,
            scrapeOpenAIDocsRaw,
            parseOpenAIDoc,
            SHOW_MD
        );
        return;
    }
    const googleScrape = valueAfter('--google-scrape-test');
    if (googleScrape) {
        await runScrapeTest(
            googleScrape,
            scrapeGoogleDocsRaw,
            parseGoogleDoc,
            SHOW_MD
        );
        return;
    }
    const anthropicScrape = valueAfter('--anthropic-scrape-test');
    if (anthropicScrape) {
        await runScrapeTest(
            anthropicScrape,
            scrapeAnthropicModelPageRaw,
            (_slug, md) => parseAnthropicModelPage(md),
            SHOW_MD
        );
        return;
    }

    const aws = resolveAwsConfig(LOCAL);
    const store = aws
        ? new S3StateStore(aws.stateBucket)
        : new FsStateStore(LOCAL_STATE_DIR);
    const targets = [localModelsFileTarget(LOCAL_MODELS_FILE)];
    if (aws)
        targets.push(s3ModelsFileTarget(aws.wwwBucket, aws.distributionId));
    console.log(
        aws
            ? `AWS mode (profile ${process.env.AWS_PROFILE}): caches in s3://${aws.stateBucket}/, publishing to s3://${aws.wwwBucket}/models.json and ${LOCAL_MODELS_FILE}`
            : `local mode: caches in ${LOCAL_STATE_DIR}, writing ${LOCAL_MODELS_FILE}`
    );
    console.log(`providers: ${[...PROVIDERS].join(', ')}`);

    const report = await runUpdate(
        {
            providers: PROVIDERS,
            write: WRITE,
            verbose: VERBOSE,
            refreshDocs: REFRESH_DOCS,
            refreshProbes: REFRESH_PROBES,
            retryNon200: RETRY_NON_200,
        },
        { store, targets }
    );

    console.log('\n=== summary ===');
    for (const o of report.outcomes) {
        console.log(
            o.status === 'updated'
                ? `${o.provider}: ${o.modelCount} models (+${o.added.length} added, ${o.changed.length} changed, ${o.unlisted.length} unlisted, ${o.warnings.length} warning(s))`
                : `${o.provider}: FAILED - kept previous ${o.modelCount} models: ${o.error}`
        );
    }

    if (WRITE) {
        await notify(
            updateEmbeds(
                report,
                aws ? 'manual run, aws mode' : 'manual run, local mode'
            )
        );
    } else {
        console.log('\n(dry run - pass --write to publish models.json)');
    }

    assertUpdateSucceeded(report);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
