import {
    afterEach,
    beforeEach,
    describe,
    expect,
    mock,
    spyOn,
    test,
} from 'bun:test';
import type { ModelOption } from '../../packages/airmailai_web/src/lib/models/types';
import * as anthropic from '../../scripts/model-list/anthropic';
import * as discord from '../../scripts/model-list/discord';
import * as env from '../../scripts/model-list/env';
import { updaterHandler } from '../../scripts/model-list/lambda';
import * as modelsFile from '../../scripts/model-list/models-file';
import { RETIRED_MODEL_IDS } from '../../scripts/model-list/overrides';
import * as shared from '../../scripts/model-list/shared';
import {
    S3StateStore,
    type StateStore,
} from '../../scripts/model-list/state-store';
import {
    assertUpdateSucceeded,
    runUpdate,
    type UpdateOptions,
} from '../../scripts/model-list/update';
import {
    acknowledgeModels,
    providersWithNewModels,
    runWatcher,
    WATCHER_STATE_KEY,
} from '../../scripts/model-list/watcher';

class MemoryStore implements StateStore {
    values = new Map<string, string>();
    describe(key: string): string {
        return `memory:${key}`;
    }
    async read(key: string): Promise<string | null> {
        return this.values.get(key) ?? null;
    }
    async write(key: string, text: string): Promise<void> {
        this.values.set(key, text);
    }
    async update(key: string, transform: (text: string | null) => string) {
        const current = this.values.get(key) ?? null;
        const text = transform(current);
        this.values.set(key, text);
        return { text, written: text !== current };
    }
}

function model(id: string): ModelOption {
    return {
        id,
        name: id,
        params: {
            contextWindow: 100,
            maxOutputTokens: 10,
            defaultMaxTokens: 10,
        },
    };
}

function options(providers: shared.Provider[] = []): UpdateOptions {
    return {
        providers: new Set(providers),
        write: true,
        verbose: false,
        refreshDocs: false,
        refreshProbes: false,
        retryNon200: false,
    };
}

const keys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY'] as const;
const savedKeys = keys.map((key) => process.env[key]);
const savedRetirements = { ...RETIRED_MODEL_IDS };

beforeEach(() => {
    for (const key of keys) process.env[key] = 'test-key';
    spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('Blocked test request', { status: 401 })
    );
    spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    mock.restore();
    Object.assign(RETIRED_MODEL_IDS, savedRetirements);
    keys.forEach((key, i) => {
        if (savedKeys[i] === undefined) delete process.env[key];
        else process.env[key] = savedKeys[i];
    });
});

describe('watcher acknowledgements', () => {
    test('failed handoffs remain detectable and acknowledgements cover only their observed snapshot', async () => {
        const store = new MemoryStore();
        let ids = ['first-release'];
        spyOn(globalThis, 'fetch').mockImplementation(
            Object.assign(
                async (input: URL | RequestInfo) => {
                    const url = String(input);
                    if (url.includes('anthropic.com'))
                        return Response.json({
                            data: ids.map((id) => ({ id })),
                        });
                    if (url.includes('openai.com'))
                        return Response.json({
                            data: [{ id: 'openai-release' }],
                        });
                    if (url.includes('googleapis.com'))
                        return Response.json({ models: [] });
                    throw new Error(`Unexpected URL: ${url}`);
                },
                { preconnect: globalThis.fetch.preconnect }
            )
        );
        const first = await runWatcher(store);
        expect(providersWithNewModels(first)).toEqual(['anthropic', 'openai']);
        expect(await store.read(WATCHER_STATE_KEY)).toBeNull();
        expect(providersWithNewModels(await runWatcher(store))).toEqual([
            'anthropic',
            'openai',
        ]);
        ids = ['first-release', 'second-release'];
        await acknowledgeModels(store, first.observedIds, ['anthropic']);
        const next = await runWatcher(store);
        expect(next.newIds.anthropic).toEqual(['second-release']);
        expect(next.newIds.openai).toEqual(['openai-release']);
        await acknowledgeModels(store, next.observedIds, ['anthropic']);
        await acknowledgeModels(store, first.observedIds, ['anthropic']);
        expect((await runWatcher(store)).newIds.anthropic).toEqual([]);
    });
});

describe('model publication', () => {
    test('syncs production metadata over a stale local copy for unrequested providers', async () => {
        const store = new MemoryStore();
        const localFile = modelsFile.emptyModelsFile();
        localFile.providers.google = [model('google-model')];
        const productionFile = structuredClone(localFile);
        productionFile.providers.google[0].params.contextWindow = 200;
        await store.write('local', modelsFile.serializeModelsFile(localFile));
        await store.write(
            'production',
            modelsFile.serializeModelsFile(productionFile)
        );
        const local = new modelsFile.StoreModelsFileTarget(store, 'local', {});
        const production = new modelsFile.StoreModelsFileTarget(
            store,
            'production',
            {}
        );
        const report = await runUpdate(options(), {
            store,
            targets: [local, production],
        });
        expect(
            (await local.read())?.providers.google[0].params.contextWindow
        ).toBe(200);
        expect(report.written).toEqual(['memory:local']);
        expect(report.unchanged).toEqual(['memory:production']);
    });

    test('merges successful results into a catalog changed after the initial read', async () => {
        const store = new MemoryStore();
        const base = modelsFile.emptyModelsFile();
        base.providers.openai = [model('existing-openai')];
        await store.write('models.json', modelsFile.serializeModelsFile(base));
        const target = new modelsFile.StoreModelsFileTarget(
            store,
            'models.json',
            {}
        );
        spyOn(anthropic, 'pipelineAnthropic').mockImplementation(async () => {
            const concurrent = structuredClone(base);
            concurrent.providers.google = [model('concurrent-google')];
            concurrent.providers.anthropic = [model('concurrent-anthropic')];
            await store.write(
                'models.json',
                modelsFile.serializeModelsFile(concurrent)
            );
            return {
                models: [
                    {
                        id: 'new-anthropic',
                        name: 'new-anthropic',
                        contextWindow: 100,
                        maxOutputTokens: 10,
                        notes: [],
                    },
                ],
                dead: [],
                toolVersionWarnings: [],
            };
        });
        const report = await runUpdate(options(['anthropic']), {
            store,
            targets: [target],
        });
        const file = await target.read();
        expect(file?.providers.anthropic.map((m) => m.id).sort()).toEqual([
            'concurrent-anthropic',
            'new-anthropic',
        ]);
        expect(file?.providers.google).toEqual([model('concurrent-google')]);
        expect(file?.providers.openai).toEqual([model('existing-openai')]);
        expect(report.outcomes[0].added).toEqual(['new-anthropic']);
    });

    test('retirement wins over stale copies and still-listed models', async () => {
        const store = new MemoryStore();
        RETIRED_MODEL_IDS.anthropic = ['retired'];
        RETIRED_MODEL_IDS.openai = ['retired-openai'];
        const stale = modelsFile.emptyModelsFile();
        stale.providers.anthropic = [model('retired'), model('keep')];
        stale.providers.openai = [model('retired-openai')];
        await store.write('local', modelsFile.serializeModelsFile(stale));
        const local = new modelsFile.StoreModelsFileTarget(store, 'local', {});
        const remote = new modelsFile.StoreModelsFileTarget(
            store,
            'remote',
            {}
        );
        spyOn(anthropic, 'pipelineAnthropic').mockResolvedValue({
            models: [
                {
                    id: 'retired',
                    name: 'retired',
                    contextWindow: 100,
                    maxOutputTokens: 10,
                    notes: [],
                },
            ],
            dead: [],
            toolVersionWarnings: [],
        });
        const report = await runUpdate(options(['anthropic']), {
            store,
            targets: [local, remote],
        });
        expect(report.retired).toEqual({
            anthropic: ['retired'],
            openai: ['retired-openai'],
        });
        expect(report.outcomes[0].unlisted).toEqual(['keep']);
        expect((await remote.read())?.providers.anthropic).toEqual([
            model('keep'),
        ]);
        expect((await remote.read())?.providers.openai).toEqual([]);
        await store.write('local', modelsFile.serializeModelsFile(stale));
        await runUpdate(options(), { store, targets: [local, remote] });
        expect((await local.read())?.providers.anthropic).toEqual([
            model('keep'),
        ]);
        expect((await remote.read())?.providers.anthropic).toEqual([
            model('keep'),
        ]);
    });

    test('dry runs preserve catalogs and no-op publishes preserve generatedAt', async () => {
        const store = new MemoryStore();
        const original = modelsFile.serializeModelsFile(
            modelsFile.emptyModelsFile()
        );
        await store.write('models', original);
        const target = new modelsFile.StoreModelsFileTarget(
            store,
            'models',
            {}
        );
        const update = spyOn(target, 'update');
        await runUpdate(
            { ...options(), write: false },
            { store, targets: [target] }
        );
        expect(update).not.toHaveBeenCalled();
        const report = await runUpdate(options(), { store, targets: [target] });
        expect(report.written).toEqual([]);
        expect(await store.read('models')).toBe(original);
    });

    test('Lambda publishes successful providers, acknowledges only them, and rejects failed outcomes', async () => {
        const store = new MemoryStore();
        const target = new modelsFile.StoreModelsFileTarget(
            store,
            'models',
            {}
        );
        const base = modelsFile.emptyModelsFile();
        base.providers.openai = [model('existing-openai')];
        await store.write('models', modelsFile.serializeModelsFile(base));
        spyOn(env, 'loadSecretsFromSsm').mockResolvedValue();
        spyOn(env, 'resolveAwsConfig').mockReturnValue({
            stateBucket: 'state',
            wwwBucket: 'www',
            distributionId: 'distribution',
        });
        spyOn(S3StateStore.prototype, 'read').mockImplementation((key) =>
            store.read(key)
        );
        spyOn(S3StateStore.prototype, 'write').mockImplementation((key, text) =>
            store.write(key, text)
        );
        spyOn(S3StateStore.prototype, 'update').mockImplementation(
            (key, transform) => store.update(key, transform)
        );
        spyOn(modelsFile, 's3ModelsFileTarget').mockReturnValue(target);
        spyOn(discord, 'notify').mockResolvedValue();
        spyOn(discord, 'notifyCrash').mockResolvedValue();
        spyOn(shared, 'fetchOpenRouterIndex').mockRejectedValue(
            new Error('OpenRouter unavailable')
        );
        spyOn(anthropic, 'pipelineAnthropic').mockResolvedValue({
            models: [
                {
                    id: 'new-anthropic',
                    name: 'new-anthropic',
                    contextWindow: 100,
                    maxOutputTokens: 10,
                    notes: [],
                },
            ],
            dead: [],
            toolVersionWarnings: [],
        });
        await expect(
            updaterHandler({
                providers: ['anthropic', 'openai'],
                observedIds: {
                    anthropic: ['new-anthropic'],
                    openai: ['new-openai'],
                },
            })
        ).rejects.toThrow('provider pipeline(s) failed: openai');
        expect((await target.read())?.providers.openai).toEqual([
            model('existing-openai'),
        ]);
        expect(
            (await target.read())?.providers.anthropic.map((m) => m.id)
        ).toEqual(['new-anthropic']);
        expect(JSON.parse((await store.read(WATCHER_STATE_KEY))!)).toEqual({
            anthropic: ['new-anthropic'],
        });
        const failed = await runUpdate(options(['openai']), {
            store,
            targets: [target],
        });
        expect(() => assertUpdateSucceeded(failed)).toThrow('openai');
    });
});

describe('Discord report limits', () => {
    test('splits oversized reports without dropping or reordering embeds', () => {
        const embeds = Array.from({ length: 23 }, (_, i) => ({
            title: String(i),
            description: 'x'.repeat(i < 3 ? 4000 : 10),
            color: 0,
        }));
        const batches = discord.batchDiscordEmbeds(embeds);
        expect(batches.flat()).toEqual(embeds);
        for (const batch of batches) {
            expect(batch.length).toBeLessThanOrEqual(10);
            expect(
                batch.reduce(
                    (n, e) => n + e.title.length + e.description.length,
                    0
                )
            ).toBeLessThanOrEqual(6000);
        }
        expect(discord.batchDiscordEmbeds([])).toEqual([]);
    });
});
