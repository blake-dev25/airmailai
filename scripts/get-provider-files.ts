import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

type ProviderName = 'anthropic' | 'openai' | 'google' | 'openrouter';

interface FileEntry {
    id: string;
    filename: string;
    sizeBytes?: number;
    created?: string;
}

const PROVIDERS: ProviderName[] = [
    'anthropic',
    'openai',
    'google',
    'openrouter',
];

const ENV: Record<ProviderName, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    google: 'GOOGLE_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
};

const ANTHROPIC_BASE = 'https://api.anthropic.com/v1/files';
const OPENAI_BASE = 'https://api.openai.com/v1/files';
const GOOGLE_BASE = 'https://generativelanguage.googleapis.com/v1beta/files';

function flag(name: string): string | undefined {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

async function apiFetch(url: string, init: RequestInit): Promise<unknown> {
    const resp = await fetch(url, init);
    const text = await resp.text();
    if (!resp.ok) {
        throw new Error(`${resp.status} ${resp.statusText}: ${text}`);
    }
    return text ? JSON.parse(text) : null;
}

function anthropicHeaders(key: string): Record<string, string> {
    return {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'files-api-2025-04-14',
    };
}

async function listAnthropic(key: string): Promise<FileEntry[]> {
    const out: FileEntry[] = [];
    let afterId: string | undefined;
    do {
        const url = new URL(ANTHROPIC_BASE);
        url.searchParams.set('limit', '1000');
        if (afterId) url.searchParams.set('after_id', afterId);
        const data = (await apiFetch(url.toString(), {
            headers: anthropicHeaders(key),
        })) as {
            data: Array<{
                id: string;
                filename: string;
                size_bytes: number;
                created_at: string;
            }>;
            has_more: boolean;
            last_id: string | null;
        };
        for (const f of data.data) {
            out.push({
                id: f.id,
                filename: f.filename,
                sizeBytes: f.size_bytes,
                created: f.created_at,
            });
        }
        afterId = data.has_more && data.last_id ? data.last_id : undefined;
    } while (afterId);
    return out;
}

async function deleteAnthropic(key: string, id: string): Promise<void> {
    await apiFetch(`${ANTHROPIC_BASE}/${id}`, {
        method: 'DELETE',
        headers: anthropicHeaders(key),
    });
}

async function listOpenAI(key: string): Promise<FileEntry[]> {
    const data = (await apiFetch(OPENAI_BASE, {
        headers: { Authorization: `Bearer ${key}` },
    })) as {
        data: Array<{
            id: string;
            filename: string;
            bytes: number;
            created_at: number;
        }>;
    };
    return data.data.map((f) => ({
        id: f.id,
        filename: f.filename,
        sizeBytes: f.bytes,
        created: new Date(f.created_at * 1000).toISOString(),
    }));
}

async function deleteOpenAI(key: string, id: string): Promise<void> {
    await apiFetch(`${OPENAI_BASE}/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${key}` },
    });
}

async function listGoogle(key: string): Promise<FileEntry[]> {
    const out: FileEntry[] = [];
    let pageToken: string | undefined;
    do {
        const url = new URL(GOOGLE_BASE);
        url.searchParams.set('pageSize', '100');
        if (pageToken) url.searchParams.set('pageToken', pageToken);
        const data = (await apiFetch(url.toString(), {
            headers: { 'x-goog-api-key': key },
        })) as {
            files?: Array<{
                name: string;
                displayName?: string;
                sizeBytes?: string;
                createTime?: string;
            }>;
            nextPageToken?: string;
        };
        for (const f of data.files ?? []) {
            out.push({
                id: f.name,
                filename: f.displayName ?? f.name,
                sizeBytes: f.sizeBytes ? Number(f.sizeBytes) : undefined,
                created: f.createTime,
            });
        }
        pageToken = data.nextPageToken;
    } while (pageToken);
    return out;
}

async function deleteGoogle(key: string, id: string): Promise<void> {
    const name = id.startsWith('files/') ? id.slice('files/'.length) : id;
    await apiFetch(`${GOOGLE_BASE}/${name}`, {
        method: 'DELETE',
        headers: { 'x-goog-api-key': key },
    });
}

async function listProvider(
    p: ProviderName,
    key: string
): Promise<FileEntry[]> {
    switch (p) {
        case 'anthropic':
            return listAnthropic(key);
        case 'openai':
            return listOpenAI(key);
        case 'google':
            return listGoogle(key);
        case 'openrouter':
            throw new Error('OpenRouter has no Files API yet');
    }
}

async function deleteFile(
    p: ProviderName,
    key: string,
    id: string
): Promise<void> {
    switch (p) {
        case 'anthropic':
            return deleteAnthropic(key, id);
        case 'openai':
            return deleteOpenAI(key, id);
        case 'google':
            return deleteGoogle(key, id);
        case 'openrouter':
            throw new Error('OpenRouter has no Files API yet');
    }
}

interface DownloadResult {
    ok: boolean;
    status: number;
    bytes?: Buffer;
    errText?: string;
}

async function downloadRest(
    url: string,
    headers: Record<string, string>
): Promise<DownloadResult> {
    const resp = await fetch(url, { headers });
    if (!resp.ok) {
        return { ok: false, status: resp.status, errText: await resp.text() };
    }
    return {
        ok: true,
        status: resp.status,
        bytes: Buffer.from(await resp.arrayBuffer()),
    };
}

async function downloadFile(
    p: ProviderName,
    key: string,
    id: string
): Promise<DownloadResult> {
    switch (p) {
        case 'openai':
            return downloadRest(`${OPENAI_BASE}/${id}/content`, {
                Authorization: `Bearer ${key}`,
            });
        case 'anthropic':
            return downloadRest(
                `${ANTHROPIC_BASE}/${id}/content`,
                anthropicHeaders(key)
            );
        case 'google':
            throw new Error('Google Files API is metadata-only (no download)');
        case 'openrouter':
            throw new Error('OpenRouter has no Files API yet');
    }
}

async function uploadFile(
    p: ProviderName,
    key: string,
    path: string,
    purpose: string
): Promise<string> {
    const data = readFileSync(path);
    const form = new FormData();
    form.append('file', new Blob([data]), basename(path));
    if (p === 'openai') {
        form.append('purpose', purpose);
        const out = (await apiFetch(OPENAI_BASE, {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}` },
            body: form,
        })) as { id: string };
        return out.id;
    }
    if (p === 'anthropic') {
        const out = (await apiFetch(ANTHROPIC_BASE, {
            method: 'POST',
            headers: anthropicHeaders(key),
            body: form,
        })) as { id: string };
        return out.id;
    }
    throw new Error(`upload not supported for ${p}`);
}

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    const kb = n / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    return `${(kb / 1024).toFixed(1)} MB`;
}

function printHelp(): void {
    console.log(`get-provider-files - list and delete files in each provider's Files API

Pure REST calls, reads keys from .env. Listing and deleting cost nothing.

Usage:
  bun scripts/get-provider-files.ts                              list all providers
  bun scripts/get-provider-files.ts --provider <name>           list one provider
  bun scripts/get-provider-files.ts --provider <name> --delete <file_id>
  bun scripts/get-provider-files.ts --provider <name> --delete-all
  bun scripts/get-provider-files.ts --provider <name> --download <file_id> [--out <path>]
  bun scripts/get-provider-files.ts --provider <name> --upload <path> [--purpose <p>]

--delete-all requires --provider; it never deletes across all providers at once.
--download: anthropic + openai only (google's Files API is metadata-only).
--upload: anthropic + openai only; --purpose defaults to user_data (openai only).

Providers: anthropic | openai | google   (openrouter has no Files API yet)
Keys read from .env: ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY`);
}

async function main() {
    if (process.argv.includes('-h') || process.argv.includes('--help')) {
        printHelp();
        return;
    }

    const providerArg = flag('--provider') as ProviderName | undefined;
    const deleteId = flag('--delete');
    const deleteAll = process.argv.includes('--delete-all');
    const downloadId = flag('--download');
    const uploadPath = flag('--upload');
    const uploadPurpose = flag('--purpose') ?? 'user_data';
    const outPath = flag('--out');

    if (providerArg && !PROVIDERS.includes(providerArg)) {
        console.error(
            `Unknown provider: ${providerArg}. Use one of: ${PROVIDERS.join(', ')}`
        );
        process.exit(1);
    }

    if (deleteId) {
        if (!providerArg) {
            console.error('--delete requires --provider <name>');
            process.exit(1);
        }
        if (providerArg === 'openrouter') {
            console.error('OpenRouter has no Files API yet');
            process.exit(1);
        }
        const key = process.env[ENV[providerArg]];
        if (!key) {
            console.error(`${ENV[providerArg]} missing from .env`);
            process.exit(1);
        }
        await deleteFile(providerArg, key, deleteId);
        console.log(`deleted ${deleteId} from ${providerArg}`);
        return;
    }

    if (uploadPath) {
        if (!providerArg) {
            console.error('--upload requires --provider <name>');
            process.exit(1);
        }
        const key = process.env[ENV[providerArg]];
        if (!key) {
            console.error(`${ENV[providerArg]} missing from .env`);
            process.exit(1);
        }
        const id = await uploadFile(
            providerArg,
            key,
            uploadPath,
            uploadPurpose
        );
        console.log(
            `uploaded ${uploadPath} to ${providerArg} as ${id} (purpose=${uploadPurpose})`
        );
        return;
    }

    if (downloadId) {
        if (!providerArg) {
            console.error('--download requires --provider <name>');
            process.exit(1);
        }
        const key = process.env[ENV[providerArg]];
        if (!key) {
            console.error(`${ENV[providerArg]} missing from .env`);
            process.exit(1);
        }
        const r = await downloadFile(providerArg, key, downloadId);
        if (!r.ok) {
            console.error(`download FAILED: HTTP ${r.status}: ${r.errText}`);
            process.exit(1);
        }
        const out = outPath ?? join('.tmp', `download-${downloadId}`);
        writeFileSync(out, r.bytes!);
        console.log(
            `downloaded ${downloadId} (${r.bytes!.byteLength} B) -> ${out}`
        );
        if (r.bytes!.byteLength <= 200) {
            console.log(
                `content: ${JSON.stringify(r.bytes!.toString('utf8'))}`
            );
        }
        return;
    }

    if (deleteAll) {
        if (!providerArg) {
            console.error('--delete-all requires --provider <name>');
            process.exit(1);
        }
        if (providerArg === 'openrouter') {
            console.error('OpenRouter has no Files API yet');
            process.exit(1);
        }
        const key = process.env[ENV[providerArg]];
        if (!key) {
            console.error(`${ENV[providerArg]} missing from .env`);
            process.exit(1);
        }
        const files = await listProvider(providerArg, key);
        if (!files.length) {
            console.log(`${providerArg}: (no files)`);
            return;
        }
        let failed = 0;
        for (const f of files) {
            try {
                await deleteFile(providerArg, key, f.id);
                console.log(`deleted ${f.id}`);
            } catch (err) {
                failed++;
                console.error(
                    `failed ${f.id}: ${err instanceof Error ? err.message : String(err)}`
                );
            }
        }
        console.log(
            `deleted ${files.length - failed}/${files.length} files from ${providerArg}`
        );
        if (failed) process.exit(1);
        return;
    }

    const targets = providerArg ? [providerArg] : PROVIDERS;
    for (const p of targets) {
        console.log(`\n=== ${p} ===`);
        if (p === 'openrouter') {
            console.log('  no Files API yet');
            continue;
        }
        const key = process.env[ENV[p]];
        if (!key) {
            console.log(`  ${ENV[p]} missing from .env (skipped)`);
            continue;
        }
        try {
            const files = await listProvider(p, key);
            if (!files.length) {
                console.log('  (no files)');
                continue;
            }
            for (const f of files) {
                const size =
                    f.sizeBytes != null ? formatBytes(f.sizeBytes) : '?';
                console.log(
                    `  ${f.id.padEnd(40)} ${size.padStart(9)}  ${f.created ?? ''}  ${f.filename}`
                );
            }
            console.log(`  total: ${files.length}`);
        } catch (err) {
            console.log(
                `  error: ${err instanceof Error ? err.message : String(err)}`
            );
        }
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
