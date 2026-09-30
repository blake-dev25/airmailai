import { readFileSync } from 'node:fs';
import { buildFirstPartyProviders } from '../../packages/airmailai_web/src/lib/models';
import {
    FIRST_PARTY_PROVIDER_IDS,
    MODELS_FILE_SCHEMA_VERSION,
    parseModelsFile,
} from '../../packages/airmailai_web/src/lib/models/modelsFile';
import type {
    ModelOption,
    ModelsFile,
    ProviderOption,
} from '../../packages/airmailai_web/src/lib/models/types';
import { LOCAL_MODELS_FILE, MODELS_FILE_KEY } from './env';
import { compareModelsByVersion } from './shared';
import {
    FsStateStore,
    S3StateStore,
    type StateStore,
    type WriteOptions,
} from './state-store';

const PUBLIC_CACHE_CONTROL = 'public, max-age=300, must-revalidate';

export interface ModelsFileTarget {
    describe(): string;
    read(): Promise<ModelsFile | null>;
    update(transform: (current: ModelsFile | null) => ModelsFile): Promise<{
        file: ModelsFile;
        written: boolean;
    }>;
}

export function serializeModelsFile(file: ModelsFile): string {
    return JSON.stringify(file, null, 4) + '\n';
}

export function emptyModelsFile(): ModelsFile {
    return {
        schemaVersion: MODELS_FILE_SCHEMA_VERSION,
        generatedAt: new Date(0).toISOString(),
        providers: { anthropic: [], openai: [], google: [] },
    };
}

export function validateModelsFile(file: ModelsFile): ModelsFile {
    return parseModelsFile(JSON.parse(serializeModelsFile(file)));
}

export function loadLocalProviders(): ProviderOption[] {
    const raw: unknown = JSON.parse(readFileSync(LOCAL_MODELS_FILE, 'utf-8'));
    return buildFirstPartyProviders(parseModelsFile(raw));
}

export class StoreModelsFileTarget implements ModelsFileTarget {
    constructor(
        private readonly store: StateStore,
        private readonly key: string,
        private readonly writeOptions: WriteOptions,
        private readonly afterWrite?: () => Promise<void>
    ) {}

    describe(): string {
        return this.store.describe(this.key);
    }

    async read(): Promise<ModelsFile | null> {
        const text = await this.store.read(this.key);
        return this.parse(text);
    }

    private parse(text: string | null): ModelsFile | null {
        if (text === null) return null;
        try {
            return parseModelsFile(JSON.parse(text));
        } catch (e) {
            throw new Error(
                `${this.describe()} is not a valid models file: ${(e as Error).message}`,
                { cause: e }
            );
        }
    }

    async update(
        transform: (current: ModelsFile | null) => ModelsFile
    ): Promise<{
        file: ModelsFile;
        written: boolean;
    }> {
        const result = await this.store.update(
            this.key,
            (text) => {
                const current = this.parse(text);
                const next = validateModelsFile(transform(current));
                if (current && sameProviders(current, next)) return text!;
                return serializeModelsFile(next);
            },
            this.writeOptions
        );
        if (result.written) await this.afterWrite?.();
        return {
            file: parseModelsFile(JSON.parse(result.text)),
            written: result.written,
        };
    }
}

export function sameProviders(a: ModelsFile, b: ModelsFile): boolean {
    return JSON.stringify(a.providers) === JSON.stringify(b.providers);
}

export function localModelsFileTarget(path: string): ModelsFileTarget {
    const dir = path.slice(0, path.length - MODELS_FILE_KEY.length);
    return new StoreModelsFileTarget(
        new FsStateStore(dir),
        MODELS_FILE_KEY,
        {}
    );
}

export function s3ModelsFileTarget(
    bucket: string,
    distributionId: string
): ModelsFileTarget {
    return new StoreModelsFileTarget(
        new S3StateStore(bucket),
        MODELS_FILE_KEY,
        {
            contentType: 'application/json; charset=utf-8',
            cacheControl: PUBLIC_CACHE_CONTROL,
        },
        async () => {
            const { CloudFrontClient, CreateInvalidationCommand } =
                await import('@aws-sdk/client-cloudfront');
            const result = await new CloudFrontClient({}).send(
                new CreateInvalidationCommand({
                    DistributionId: distributionId,
                    InvalidationBatch: {
                        CallerReference: `models-json-${Date.now()}`,
                        Paths: { Quantity: 1, Items: [`/${MODELS_FILE_KEY}`] },
                    },
                })
            );
            console.log(
                `OK CloudFront invalidation ${result.Invalidation?.Id ?? '?'} for /${MODELS_FILE_KEY}`
            );
        }
    );
}

export interface ProviderMerge {
    models: ModelOption[];
    added: string[];
    changed: string[];
    unlisted: string[];
}

export function mergeProviderModels(
    base: ModelOption[],
    fresh: ModelOption[]
): ProviderMerge {
    const freshIds = new Set(fresh.map((m) => m.id));
    const baseById = new Map(base.map((m) => [m.id, m]));
    const added: string[] = [];
    const changed: string[] = [];
    for (const m of fresh) {
        const previous = baseById.get(m.id);
        if (!previous) added.push(m.id);
        else if (JSON.stringify(previous) !== JSON.stringify(m)) {
            changed.push(m.id);
        }
    }
    const kept = base.filter((m) => !freshIds.has(m.id));
    const models = [...fresh, ...kept].sort(compareModelsByVersion);
    return { models, added, changed, unlisted: kept.map((m) => m.id) };
}

export function mergeBaseFiles(files: ModelsFile[]): ModelsFile {
    const merged = emptyModelsFile();
    for (const file of files) {
        if (file.generatedAt > merged.generatedAt) {
            merged.generatedAt = file.generatedAt;
        }
        for (const provider of FIRST_PARTY_PROVIDER_IDS) {
            const byId = new Map(
                merged.providers[provider].map((m) => [m.id, m])
            );
            for (const m of file.providers[provider]) byId.set(m.id, m);
            merged.providers[provider] = [...byId.values()].sort(
                compareModelsByVersion
            );
        }
    }
    return merged;
}
