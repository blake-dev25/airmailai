import { resolve } from 'node:path';

export const LOCAL_STATE_DIR = resolve(import.meta.dirname, '../.tmp');
export const LOCAL_MODELS_FILE = resolve(
    import.meta.dirname,
    '../../packages/airmailai_web/static/models.json'
);
export const MODELS_FILE_KEY = 'models.json';
export const SNAPSHOT_PREFIX = 'snapshots/';

export type ApiKeyName =
    | 'ANTHROPIC_API_KEY'
    | 'OPENAI_API_KEY'
    | 'GOOGLE_API_KEY'
    | 'OPENROUTER_API_KEY';

export const SECRET_ENV_NAMES = [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GOOGLE_API_KEY',
    'OPENROUTER_API_KEY',
    'AIRMAILAI_DISCORD_WEBHOOK_URL',
] as const;

export interface AwsConfig {
    wwwBucket: string;
    distributionId: string;
    stateBucket: string;
}

export function isLambda(): boolean {
    return !!process.env.AWS_LAMBDA_FUNCTION_NAME;
}

export function requireEnv(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(
            `${name} missing from ${isLambda() ? 'the Lambda environment' : '.env'}`
        );
    }
    return value;
}

export function requireApiKey(name: ApiKeyName): string {
    return requireEnv(name);
}

export function discordWebhookUrl(): string | undefined {
    return process.env.AIRMAILAI_DISCORD_WEBHOOK_URL?.trim() || undefined;
}

export function resolveAwsConfig(forceLocal: boolean): AwsConfig | null {
    if (forceLocal) return null;
    const profile = process.env.AIRMAILAI_WEB_AWS_PROFILE?.trim();
    if (!isLambda() && !profile) return null;
    if (profile) process.env.AWS_PROFILE = profile;
    return {
        wwwBucket: requireEnv('AIRMAILAI_WEB_S3_BUCKET'),
        distributionId: requireEnv('AIRMAILAI_WEB_CLOUDFRONT_DISTRIBUTION_ID'),
        stateBucket: requireEnv('AIRMAILAI_MODEL_LIST_STATE_BUCKET'),
    };
}

export async function loadSecretsFromSsm(): Promise<void> {
    const prefix = requireEnv('AIRMAILAI_MODEL_LIST_SSM_PREFIX');
    const { SSMClient, GetParametersByPathCommand } =
        await import('@aws-sdk/client-ssm');
    const client = new SSMClient({});
    let nextToken: string | undefined;
    let loaded = 0;
    do {
        const page = await client.send(
            new GetParametersByPathCommand({
                Path: prefix,
                WithDecryption: true,
                NextToken: nextToken,
            })
        );
        for (const param of page.Parameters ?? []) {
            if (!param.Name || param.Value === undefined) continue;
            const name = param.Name.slice(param.Name.lastIndexOf('/') + 1);
            process.env[name] = param.Value;
            loaded++;
        }
        nextToken = page.NextToken;
    } while (nextToken);
    if (loaded === 0) {
        throw new Error(`No SSM parameters found under ${prefix}`);
    }
    console.log(`loaded ${loaded} secret(s) from SSM ${prefix}`);
}
