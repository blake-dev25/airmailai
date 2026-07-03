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

function readRootEnvVar(name: string): string | undefined {
    const env = readFile('.env');
    if (!env) return undefined;
    for (const line of env.split('\n')) {
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        if (line.slice(0, eq).trim() === name) return line.slice(eq + 1).trim();
    }
    return undefined;
}

function readBuildFlag(name: string): string | undefined {
    return process.env[name] ?? readRootEnvVar(name);
}

const logLevel = readBuildFlag('COURIERAI_LOG_LEVEL') ?? 'errors';
const allowLocalhost = readBuildFlag('WXT_ALLOW_LOCALHOST') === 'true';

// Verbosity is driven by BUILD_VERBOSE so the default `bun run build` stays
// quiet on warnings (only errors surface), and `bun run build:verbose` opts
// back into the full Vite + Rolldown warning stream when debugging.
const verbose = !!process.env.BUILD_VERBOSE;

export default defineConfig({
    vite: () => ({
        logLevel: verbose ? 'info' : 'error',
        define: {
            __LOG_LEVEL__: JSON.stringify(logLevel),
            __ALLOW_LOCALHOST__: JSON.stringify(allowLocalhost),
        },
        build: {
            sourcemap: true,
            ...(verbose ? {} : { rollupOptions: { onwarn: () => {} } }),
        },
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
        description: 'Chat with AI using your own API keys',
        icons: {
            16: '/icon-16.png',
            32: '/icon-32.png',
            48: '/icon-48.png',
            128: '/icon-128.png',
        },
        version,
        ...(versionName && versionName !== version
            ? { version_name: versionName }
            : {}),
        permissions: ['storage'],
        host_permissions: [
            'https://api.anthropic.com/*',
            'https://api.openai.com/*',
            'https://generativelanguage.googleapis.com/*',
            'https://openrouter.ai/*',
        ],
        externally_connectable: {
            matches: [
                ...(allowLocalhost ? ['http://localhost:*/*'] : []),
                'https://courierai.net/*',
            ],
        },
    },
});
