import { $ } from 'bun';
import { join } from 'node:path';

function requireEnv(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} missing from .env`);
    return value;
}

const BUCKET = requireEnv('COURIERAI_WEB_S3_BUCKET');
const DIST_ID = requireEnv('COURIERAI_WEB_CLOUDFRONT_DISTRIBUTION_ID');
const SHORT_CACHE = 'public, max-age=300, must-revalidate';
const LONG_CACHE = 'public, max-age=31536000, immutable';

const root = join(import.meta.dirname, '..');
const dist = join(root, 'packages/courierai_web/dist');

console.log('> Building courierai_web (gen-version + check + build)...');
await $`bun run build:web`.cwd(root);

// Order: assets and legal first (additive — no --delete so stale-cached HTML keeps resolving old
// hashes during the window), then HTML, then invalidate. Once invalidation completes, no edge can
// be serving stale HTML, so we sync assets again with --delete to prune orphan hashes.

console.log('\n> S3 sync /assets/* (immutable long cache)...');
await $`aws s3 sync ${dist}/assets/ s3://${BUCKET}/assets/ --cache-control ${LONG_CACHE} --no-progress`;

console.log('\n> S3 cp /legal/* (text/markdown)...');
await $`aws s3 cp ${dist}/legal/ s3://${BUCKET}/legal/ --recursive --cache-control ${SHORT_CACHE} --content-type "text/markdown; charset=utf-8" --no-progress`;

console.log('\n> S3 sync HTML/root (short cache, --delete)...');
await $`aws s3 sync ${dist}/ s3://${BUCKET}/ --exclude "assets/*" --exclude "legal/*" --cache-control ${SHORT_CACHE} --delete --no-progress`;

console.log('\n> CloudFront invalidation...');
const invalidation =
    await $`aws cloudfront create-invalidation --distribution-id ${DIST_ID} --paths "/*"`.json();
const invalidationId = invalidation.Invalidation.Id;

console.log(
    `\n> Waiting for invalidation ${invalidationId} (typically 1-5 min)...`
);
await $`aws cloudfront wait invalidation-completed --distribution-id ${DIST_ID} --id ${invalidationId}`;

console.log('\n> Pruning orphan /assets/* (--delete)...');
await $`aws s3 sync ${dist}/assets/ s3://${BUCKET}/assets/ --cache-control ${LONG_CACHE} --delete --no-progress`;

console.log('\nDeployed: https://courierai.net');
