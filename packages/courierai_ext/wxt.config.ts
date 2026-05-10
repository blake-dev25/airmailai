import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'wxt';

function readFile(name: string): string | undefined {
    try {
        return readFileSync(
            join(import.meta.dirname, '../..', name),
            'utf-8'
        ).trim();
    } catch {
        return undefined;
    }
}

const version = readFile('VERSION') ?? '0.0.0.1';
const versionName = readFile('VERSION_NAME');

// Verbosity is driven by BUILD_VERBOSE so the default `bun run build` stays
// quiet on warnings (only errors surface), and `bun run build:verbose` opts
// back into the full Vite + Rolldown warning stream when debugging.
const verbose = !!process.env.BUILD_VERBOSE;

export default defineConfig({
    vite: () => ({
        logLevel: verbose ? 'info' : 'error',
        ...(verbose ? {} : { build: { rollupOptions: { onwarn: () => {} } } }),
    }),
    zip: {
        artifactTemplate: 'zip/courierai_ext.zip',
    },
    hooks: {
        'zip:extension:start': (wxt) => {
            mkdirSync(join(wxt.config.outBaseDir, 'zip'), { recursive: true });
        },
    },
    manifest: {
        name: 'CourierAI',
        description: 'Chat with LLMs using your own API keys',
        version,
        ...(versionName && versionName !== version
            ? { version_name: versionName }
            : {}),
        permissions: ['storage'],
        host_permissions: ['https://openrouter.ai/*'],
        externally_connectable: {
            matches: ['http://localhost:*/*', 'https://*.courierai.net/*'],
        },
    },
});
