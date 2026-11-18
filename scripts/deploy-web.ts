import { $ } from 'bun';
import { join } from 'node:path';
import {
    parseAssetRetentionManifest,
    planAssetRetention,
} from './asset-retention';
import { assertKnownFlags } from './cli-flags';

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
const SITE_ORIGIN = 'https://airmailai.net';
const SECURITY_HEADER_PATHS = ['/', '/app/'];
const EXPECTED_SECURITY_HEADERS: Record<string, string> = {
    'Content-Security-Policy':
        "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy':
        'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
};

async function verifySecurityHeaders(): Promise<void> {
    const problems: string[] = [];
    for (const path of SECURITY_HEADER_PATHS) {
        const response = await fetch(`${SITE_ORIGIN}${path}`, {
            method: 'HEAD',
            cache: 'no-store',
        });
        if (!response.ok) {
            problems.push(`${path}: HTTP ${response.status}`);
            continue;
        }
        for (const [name, expected] of Object.entries(
            EXPECTED_SECURITY_HEADERS
        )) {
            const actual = response.headers.get(name);
            if (actual === expected) continue;
            problems.push(
                actual === null
                    ? `${path}: ${name} is missing`
                    : `${path}: ${name} is "${actual}", expected "${expected}"`
            );
        }
    }
    if (problems.length > 0) {
        throw new Error(
            `The deploy finished, but the live security headers do not match the expected CloudFront response headers policy:\n${problems.join('\n')}`
        );
    }
}

const root = join(import.meta.dirname, '..');
const dist = join(root, 'packages/airmailai_web/dist');
const retentionKey = 'deploy-metadata/asset-retention.json';

const args = process.argv.slice(2);
assertKnownFlags(args, ['--allow-dirty']);
const uncommitted = (await $`git status --porcelain`.cwd(root).text()).trim();
if (uncommitted && !args.includes('--allow-dirty')) {
    throw new Error(
        `Refusing to deploy with uncommitted changes - commit them or pass --allow-dirty:\n${uncommitted}`
    );
}

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

console.log('\n> S3 cp /legal/*.md (text/markdown)...');
await $`aws s3 cp ${dist}/legal/ s3://${BUCKET}/legal/ --recursive --exclude "*" --include "*.md" --cache-control ${SHORT_CACHE} --content-type "text/markdown; charset=utf-8" --no-progress`;

console.log('\n> S3 cp /legal/*.txt (text/plain)...');
await $`aws s3 cp ${dist}/legal/ s3://${BUCKET}/legal/ --recursive --exclude "*" --include "*.txt" --cache-control ${SHORT_CACHE} --content-type "text/plain; charset=utf-8" --no-progress`;

console.log('\n> S3 cp /changelog.md (text/markdown)...');
await $`aws s3 cp ${dist}/changelog.md s3://${BUCKET}/changelog.md --cache-control ${SHORT_CACHE} --content-type "text/markdown; charset=utf-8" --no-progress`;

console.log('\n> S3 cp security.txt (text/plain)...');
for (const key of ['.well-known/security.txt', 'security.txt']) {
    await $`aws s3 cp ${dist}/security.txt s3://${BUCKET}/${key} --cache-control ${SHORT_CACHE} --content-type "text/plain; charset=utf-8" --no-progress`;
}

console.log('\n> S3 sync HTML/root (short cache, --delete)...');
await $`aws s3 sync ${dist}/ s3://${BUCKET}/ --exclude "assets/*" --exclude "legal/*" --exclude "changelog.md" --exclude "security.txt" --exclude ".well-known/*" --exclude "deploy-metadata/*" --exclude "models.json" --cache-control ${SHORT_CACHE} --delete --no-progress`;

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
        JSON.stringify({ Objects: batch.map((Key) => ({ Key })), Quiet: false })
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

console.log('\n> Verifying live security headers...');
await verifySecurityHeaders();

console.log(`\nDeployed: ${SITE_ORIGIN}`);
