import { $ } from 'bun';
import { join } from 'node:path';
import {
    parseAssetRetentionManifest,
    planAssetRetention,
} from './asset-retention';

function requireEnv(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} missing from .env`);
    return value;
}

const BUCKET = requireEnv('AIRMAILAI_WEB_S3_BUCKET');
const DIST_ID = requireEnv('AIRMAILAI_WEB_CLOUDFRONT_DISTRIBUTION_ID');
process.env.AWS_PROFILE = requireEnv('AIRMAILAI_WEB_AWS_PROFILE');
const SHORT_CACHE = 'public, max-age=300, must-revalidate';
const LONG_CACHE = 'public, max-age=31536000, immutable';

const root = join(import.meta.dirname, '..');
const dist = join(root, 'packages/airmailai_web/dist');
const retentionKey = 'deploy-metadata/asset-retention.json';

console.log(
    `> Verifying AWS credentials (profile ${process.env.AWS_PROFILE})...`
);
try {
    await $`aws sts get-caller-identity --query Account --output text`.quiet();
} catch {
    throw new Error(
        `AWS credentials expired or missing - run: aws login --profile ${process.env.AWS_PROFILE}`
    );
}

console.log('> Building airmailai_web (gen-version + check + build)...');
await $`bun run build:web`
    .cwd(root)
    .env({ ...process.env, AIRMAILAI_LOG_LEVEL: 'errors' });

const versionName = (await Bun.file(join(root, 'VERSION_NAME')).text()).trim();
await Bun.write(
    join(dist, 'version.json'),
    JSON.stringify({ version: versionName })
);

const retentionListing =
    (await $`aws s3api list-objects-v2 --bucket ${BUCKET} --prefix ${retentionKey} --output json`.json()) as {
        Contents?: Array<{ Key: string }>;
    };
const previousRetention = retentionListing.Contents?.some(
    (entry) => entry.Key === retentionKey
)
    ? parseAssetRetentionManifest(
          await $`aws s3 cp s3://${BUCKET}/${retentionKey} - --only-show-errors`.json()
      )
    : null;
const assetListing =
    (await $`aws s3api list-objects-v2 --bucket ${BUCKET} --prefix assets/ --output json`.json()) as {
        Contents?: Array<{ Key: string }>;
    };
const currentAssets: string[] = [];
for await (const path of new Bun.Glob('**/*').scan({
    cwd: join(dist, 'assets'),
    onlyFiles: true,
})) {
    currentAssets.push(`assets/${path.replaceAll('\\', '/')}`);
}
if (!currentAssets.length) throw new Error('No built assets found.');

console.log('\n> S3 sync /assets/* (immutable long cache)...');
await $`aws s3 sync ${dist}/assets/ s3://${BUCKET}/assets/ --cache-control ${LONG_CACHE} --no-progress`;

console.log('\n> S3 cp /legal/* (text/markdown)...');
await $`aws s3 cp ${dist}/legal/ s3://${BUCKET}/legal/ --recursive --cache-control ${SHORT_CACHE} --content-type "text/markdown; charset=utf-8" --no-progress`;

console.log('\n> S3 cp /changelog.md (text/markdown)...');
await $`aws s3 cp ${dist}/changelog.md s3://${BUCKET}/changelog.md --cache-control ${SHORT_CACHE} --content-type "text/markdown; charset=utf-8" --no-progress`;

console.log('\n> S3 sync HTML/root (short cache, --delete)...');
await $`aws s3 sync ${dist}/ s3://${BUCKET}/ --exclude "assets/*" --exclude "legal/*" --exclude "changelog.md" --exclude "deploy-metadata/*" --cache-control ${SHORT_CACHE} --delete --no-progress`;

console.log('\n> CloudFront invalidation...');
const invalidation =
    await $`aws cloudfront create-invalidation --distribution-id ${DIST_ID} --paths "/*"`.json();
const invalidationId = invalidation.Invalidation.Id;

console.log(
    `\n> Waiting for invalidation ${invalidationId} (typically 1-5 min)...`
);
await $`aws cloudfront wait invalidation-completed --distribution-id ${DIST_ID} --id ${invalidationId}`;

const retention = planAssetRetention(
    previousRetention,
    (assetListing.Contents ?? []).map((entry) => entry.Key),
    currentAssets,
    Date.now()
);
const manifestFile = join(root, '.tmp/asset-retention.json');
await Bun.write(manifestFile, JSON.stringify(retention.manifest));
await $`aws s3 cp ${manifestFile} s3://${BUCKET}/${retentionKey} --cache-control no-store --content-type application/json --no-progress`;
console.log(
    `\n> Pruning ${retention.expired.length} assets unused for seven days...`
);
for (let offset = 0; offset < retention.expired.length; offset += 1000) {
    const batch = retention.expired.slice(offset, offset + 1000);
    const deleteFile = join(root, '.tmp/expired-assets.json');
    await Bun.write(
        deleteFile,
        JSON.stringify({ Objects: batch.map((Key) => ({ Key })), Quiet: true })
    );
    const result =
        (await $`aws s3api delete-objects --bucket ${BUCKET} --delete ${`file://${deleteFile}`} --output json`.json()) as {
            Errors?: Array<{ Key: string; Message: string }>;
        };
    if (result.Errors?.length)
        throw new Error(
            `Asset cleanup failed: ${JSON.stringify(result.Errors)}`
        );
}

console.log('\nDeployed: https://airmailai.net');
