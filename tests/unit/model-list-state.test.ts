import { describe, expect, test } from 'bun:test';
import { S3Client } from '@aws-sdk/client-s3';
import { mkdir, mkdtemp, rmdir, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import {
    FsStateStore,
    S3StateStore,
} from '../../scripts/model-list/state-store';
import {
    acknowledgeModels,
    WATCHER_STATE_KEY,
} from '../../scripts/model-list/watcher';

function memoryS3(initial: string | null = null) {
    const state = {
        text: initial,
        revision: 1,
        conflicts: 0,
        failPuts: 0,
        puts: [] as Record<string, string>[],
    };
    const response = (
        statusCode: number,
        text: string,
        headers: Record<string, string> = {}
    ) => ({
        response: { statusCode, headers, body: Readable.from([text]) },
    });
    const client = new S3Client({
        region: 'us-east-1',
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
        maxAttempts: 1,
        requestChecksumCalculation: 'WHEN_REQUIRED',
        requestHandler: {
            async handle(request: {
                method: string;
                headers: Record<string, string>;
                body?: unknown;
            }) {
                if (request.method === 'GET') {
                    if (state.text === null)
                        return response(
                            404,
                            '<Error><Code>NoSuchKey</Code></Error>'
                        );
                    return response(200, state.text, {
                        etag: `"${state.revision}"`,
                        'content-type': 'application/json',
                    });
                }
                if (
                    request.method !== 'PUT' ||
                    typeof request.body !== 'string'
                )
                    throw new Error('Unexpected S3 request');
                state.puts.push(request.headers);
                if (state.failPuts)
                    return response(
                        state.failPuts,
                        '<Error><Code>AccessDenied</Code></Error>'
                    );
                if (
                    (request.headers['if-none-match'] === '*' &&
                        state.text !== null) ||
                    (request.headers['if-match'] !== undefined &&
                        request.headers['if-match'] !== `"${state.revision}"`)
                ) {
                    state.conflicts++;
                    return response(
                        412,
                        '<Error><Code>PreconditionFailed</Code></Error>'
                    );
                }
                state.text = request.body;
                state.revision++;
                return response(200, '', { etag: `"${state.revision}"` });
            },
        },
    });
    return { state, store: new S3StateStore('test-bucket', client) };
}

describe('conditional S3 updates', () => {
    test.each([null, '[]'])(
        'preserves competing updates starting from %j',
        async (initial) => {
            const { state, store } = memoryS3(initial);
            const append = (id: string) => (text: string | null) => {
                const ids: string[] = text === null ? [] : JSON.parse(text);
                return JSON.stringify([...new Set([...ids, id])]);
            };
            await Promise.all([
                store.update('models.json', append('anthropic-release')),
                store.update('models.json', append('openai-release')),
            ]);
            expect(JSON.parse(state.text!).sort()).toEqual([
                'anthropic-release',
                'openai-release',
            ]);
            expect(state.conflicts).toBeGreaterThan(0);
            expect(
                state.puts[0][initial === null ? 'if-none-match' : 'if-match']
            ).toBe(initial === null ? '*' : '"1"');
            expect(state.puts.at(-1)?.['if-match']).toBe('"2"');
        }
    );

    test('concurrent acknowledgements preserve successful providers and newer snapshots', async () => {
        const { state, store } = memoryS3();
        await Promise.all([
            acknowledgeModels(store, { anthropic: ['first', 'second'] }, [
                'anthropic',
            ]),
            acknowledgeModels(store, { openai: ['openai-release'] }, [
                'openai',
            ]),
        ]);
        await acknowledgeModels(store, { anthropic: ['first'] }, ['anthropic']);
        expect(JSON.parse(state.text!)).toEqual({
            anthropic: ['first', 'second'],
            openai: ['openai-release'],
        });
        expect(await store.read(WATCHER_STATE_KEY)).toBe(state.text);
    });

    test('does not write unchanged data and surfaces authorization failures', async () => {
        const { state, store } = memoryS3('existing');
        expect(await store.update('models', (text) => text!)).toEqual({
            text: 'existing',
            written: false,
        });
        expect(state.puts).toHaveLength(0);
        state.failPuts = 403;
        await expect(
            store.update('models', () => 'replacement')
        ).rejects.toThrow();
        expect(state.text).toBe('existing');
        expect(state.puts).toHaveLength(1);
    });
});

test('local updates serialize across store instances and release locks after errors', async () => {
    const root = resolve('.tmp');
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(resolve(root, 'model-list-state-test-'));
    const first = new FsStateStore(dir);
    const second = new FsStateStore(dir);
    try {
        const increment = (text: string | null) =>
            String(Number(text ?? 0) + 1);
        await Promise.all([
            first.update('counter', increment),
            second.update('counter', increment),
        ]);
        expect(await first.read('counter')).toBe('2');
        await expect(
            first.update('counter', () => {
                throw new Error('test failure');
            })
        ).rejects.toThrow('test failure');
        await second.update('counter', increment);
        expect(await first.read('counter')).toBe('3');
    } finally {
        await unlink(resolve(dir, 'counter'));
        await rmdir(dir);
    }
});
