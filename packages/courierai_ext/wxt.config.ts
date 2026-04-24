import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'wxt';

function readVersion(): string {
    try {
        return readFileSync(
            join(import.meta.dirname, '../../VERSION'),
            'utf-8'
        ).trim();
    } catch {
        return '0.0.0.0';
    }
}

export default defineConfig({
    vite: () => ({ logLevel: 'warn' }),
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
        version: readVersion(),
        permissions: ['storage'],
        externally_connectable: {
            matches: ['http://localhost:*/*', 'https://*.courierai.net/*'],
        },
    },
});
