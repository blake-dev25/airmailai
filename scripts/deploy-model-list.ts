import { $ } from 'bun';
import { zipSync } from 'fflate';
import { join } from 'node:path';
import { SECRET_ENV_NAMES, requireEnv } from './model-list/env';

const STACK_NAME = 'airmailai-model-list';
const SSM_PREFIX = '/airmailai/model-list/';
const FUNCTIONS = [
    'airmailai-model-list-watcher',
    'airmailai-model-list-updater',
];

process.env.AWS_PROFILE = requireEnv('AIRMAILAI_WEB_AWS_PROFILE');
const wwwBucket = requireEnv('AIRMAILAI_WEB_S3_BUCKET');
const distributionId = requireEnv('AIRMAILAI_WEB_CLOUDFRONT_DISTRIBUTION_ID');
const stateBucket = requireEnv('AIRMAILAI_MODEL_LIST_STATE_BUCKET');
const secrets = SECRET_ENV_NAMES.map((name) => [name, requireEnv(name)]);

const root = join(import.meta.dirname, '..');
const outDir = join(root, '.tmp/model-list-lambda');
const zipPath = join(outDir, 'model-list-lambda.zip').replaceAll('\\', '/');
const templatePath = join(root, 'infra/model-list.cfn.yaml').replaceAll(
    '\\',
    '/'
);

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

console.log('> Bundling Lambda handlers...');
const build = await Bun.build({
    entrypoints: [join(root, 'scripts/model-list/lambda.ts')],
    outdir: outDir,
    target: 'node',
    format: 'esm',
    minify: false,
    sourcemap: 'none',
});
if (!build.success) {
    for (const log of build.logs) console.error(log);
    throw new Error('Lambda bundle failed');
}
const bundlePath = build.outputs.find((o) => o.kind === 'entry-point')?.path;
if (!bundlePath) throw new Error('Lambda bundle produced no entry point');
const bundle = await Bun.file(bundlePath).bytes();
const zip = zipSync({ 'index.mjs': bundle }, { level: 9 });
await Bun.write(zipPath, zip);
console.log(`  bundle ${bundle.length} bytes, zip ${zip.length} bytes`);

console.log(`> Deploying CloudFormation stack ${STACK_NAME}...`);
await $`aws cloudformation deploy --template-file ${templatePath} --stack-name ${STACK_NAME} --capabilities CAPABILITY_NAMED_IAM --no-fail-on-empty-changeset --parameter-overrides WwwBucketName=${wwwBucket} CloudFrontDistributionId=${distributionId} StateBucketName=${stateBucket} SsmPrefix=${SSM_PREFIX}`;

console.log(`> Writing ${secrets.length} secret(s) to SSM ${SSM_PREFIX}...`);
for (const [name, value] of secrets) {
    await $`aws ssm put-parameter --name ${SSM_PREFIX + name} --type SecureString --value ${value} --overwrite`.quiet();
    console.log(`  ${SSM_PREFIX}${name}`);
}

for (const fn of FUNCTIONS) {
    console.log(`> Uploading code to ${fn}...`);
    await $`aws lambda update-function-code --function-name ${fn} --zip-file ${`fileb://${zipPath}`}`.quiet();
    await $`aws lambda wait function-updated --function-name ${fn}`;
}

console.log(`
Deployed ${STACK_NAME}.
  watcher:  ${FUNCTIONS[0]} (hourly at :05)
  updater:  ${FUNCTIONS[1]} (invoked by the watcher on new models)
  state:    s3://${stateBucket}/
Smoke test:
  aws lambda invoke --function-name ${FUNCTIONS[0]} --profile ${process.env.AWS_PROFILE} .tmp/watcher-out.json && cat .tmp/watcher-out.json`);
