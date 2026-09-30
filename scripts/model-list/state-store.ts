import { createHash } from 'node:crypto';
import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import type { S3Client } from '@aws-sdk/client-s3';
import { LOCAL_STATE_DIR } from './env';

export interface WriteOptions {
    contentType?: string;
    cacheControl?: string;
}

export interface StateStore {
    describe(key: string): string;
    read(key: string): Promise<string | null>;
    write(key: string, text: string, options?: WriteOptions): Promise<void>;
    update(
        key: string,
        transform: (text: string | null) => string,
        options?: WriteOptions
    ): Promise<StateUpdate>;
}

export interface StateUpdate {
    text: string;
    written: boolean;
}

export class FsStateStore implements StateStore {
    constructor(private readonly rootDir: string) {}

    describe(key: string): string {
        return resolve(this.rootDir, key);
    }

    async read(key: string): Promise<string | null> {
        try {
            return await readFile(this.describe(key), 'utf-8');
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw e;
        }
    }

    async write(key: string, text: string): Promise<void> {
        const path = this.describe(key);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, text);
    }

    async update(
        key: string,
        transform: (text: string | null) => string
    ): Promise<StateUpdate> {
        const path = this.describe(key);
        const hash = createHash('sha256').update(path).digest('hex');
        const lockPath = resolve(LOCAL_STATE_DIR, 'locks', `${hash}.lock`);
        await mkdir(dirname(lockPath), { recursive: true });
        for (let attempt = 0; attempt < 50; attempt++) {
            let lock;
            try {
                lock = await open(lockPath, 'wx');
            } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
                await setTimeout(100);
                continue;
            }
            try {
                const current = await this.read(key);
                const text = transform(current);
                const written = text !== current;
                if (written) await this.write(key, text);
                return { text, written };
            } finally {
                await lock.close();
                await unlink(lockPath);
            }
        }
        throw new Error(
            `Timed out waiting to update ${path}. If no other model-list process is running, remove the stale lock at ${lockPath}.`
        );
    }
}

export class S3StateStore implements StateStore {
    constructor(
        private readonly bucket: string,
        private client?: S3Client
    ) {}

    describe(key: string): string {
        return `s3://${this.bucket}/${key}`;
    }

    private async s3(): Promise<S3Client> {
        if (!this.client) {
            const { S3Client } = await import('@aws-sdk/client-s3');
            this.client = new S3Client({});
        }
        return this.client;
    }

    async read(key: string): Promise<string | null> {
        return (await this.readVersion(key)).text;
    }

    private async readVersion(
        key: string
    ): Promise<{ text: string | null; etag?: string }> {
        const { GetObjectCommand } = await import('@aws-sdk/client-s3');
        try {
            const res = await (
                await this.s3()
            ).send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
            if (!res.Body || !res.ETag) {
                throw new Error(
                    `Missing body or ETag for ${this.describe(key)}`
                );
            }
            return { text: await res.Body.transformToString(), etag: res.ETag };
        } catch (e) {
            const name = (e as { name?: string }).name;
            if (name === 'NoSuchKey' || name === 'NotFound')
                return { text: null };
            throw e;
        }
    }

    async update(
        key: string,
        transform: (text: string | null) => string,
        options: WriteOptions = {}
    ): Promise<StateUpdate> {
        const { PutObjectCommand } = await import('@aws-sdk/client-s3');
        const client = await this.s3();
        for (let attempt = 0; attempt < 10; attempt++) {
            const current = await this.readVersion(key);
            const text = transform(current.text);
            if (text === current.text) return { text, written: false };
            try {
                await client.send(
                    new PutObjectCommand({
                        Bucket: this.bucket,
                        Key: key,
                        Body: text,
                        ContentType: options.contentType ?? 'application/json',
                        CacheControl: options.cacheControl,
                        ...(current.etag
                            ? { IfMatch: current.etag }
                            : { IfNoneMatch: '*' }),
                    })
                );
                return { text, written: true };
            } catch (e) {
                const status = (
                    e as { $metadata?: { httpStatusCode?: number } }
                ).$metadata?.httpStatusCode;
                if (
                    status !== 409 &&
                    status !== 412 &&
                    !(status === 404 && current.etag)
                )
                    throw e;
                console.log(
                    `Concurrent write to ${this.describe(key)} - reloading and retrying`
                );
            }
        }
        throw new Error(`Too many concurrent writes to ${this.describe(key)}`);
    }

    async write(
        key: string,
        text: string,
        options: WriteOptions = {}
    ): Promise<void> {
        const { PutObjectCommand } = await import('@aws-sdk/client-s3');
        await (
            await this.s3()
        ).send(
            new PutObjectCommand({
                Bucket: this.bucket,
                Key: key,
                Body: text,
                ContentType: options.contentType ?? 'application/json',
                CacheControl: options.cacheControl,
            })
        );
    }
}
