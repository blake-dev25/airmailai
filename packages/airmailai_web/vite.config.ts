import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const rootDir = join(import.meta.dirname, '../..');

function readVersion(): string {
    for (const name of ['VERSION_NAME', 'VERSION']) {
        try {
            return readFileSync(join(rootDir, name), 'utf-8').trim();
        } catch {}
    }
    return '0.0.0.1';
}

function readLogLevel(): string {
    if (process.env.AIRMAILAI_LOG_LEVEL) {
        return process.env.AIRMAILAI_LOG_LEVEL;
    }
    let env: string;
    try {
        env = readFileSync(join(rootDir, '.env'), 'utf-8');
    } catch {
        return 'errors';
    }
    for (const line of env.split('\n')) {
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        if (line.slice(0, eq).trim() === 'AIRMAILAI_LOG_LEVEL') {
            return line.slice(eq + 1).trim();
        }
    }
    return 'errors';
}

function readLegalVersion(): string {
    const hash = createHash('sha256');
    const legalDir = join(import.meta.dirname, 'static/legal');

    // *** Normalize line endings before hashing so the version stays stable even
    // if a non-git tool (editor, script, etc.) rewrites the file with CRLF.
    for (const name of ['terms.md', 'privacy.md']) {
        hash.update(name);
        hash.update('\0');
        hash.update(
            readFileSync(join(legalDir, name), 'utf-8').replace(/\r\n/g, '\n')
        );
        hash.update('\0');
    }

    return hash.digest('hex');
}

const verbose = !!process.env.BUILD_VERBOSE;

export default defineConfig(({ isPreview }) => ({
    logLevel: verbose || isPreview ? 'info' : 'error',
    publicDir: 'static',
    define: {
        __APP_VERSION__: JSON.stringify(readVersion()),
        __LEGAL_VERSION__: JSON.stringify(readLegalVersion()),
        __LOG_LEVEL__: JSON.stringify(readLogLevel()),
    },
    plugins: [tailwindcss(), svelte()],
    preview: {
        open: '/app/',
    },
    build: {
        sourcemap: true,
        rollupOptions: {
            ...(verbose ? {} : { onwarn: () => {} }),
            input: {
                main: resolve(import.meta.dirname, 'index.html'),
                app: resolve(import.meta.dirname, 'app/index.html'),
                faq: resolve(import.meta.dirname, 'faq/index.html'),
                designSecurity: resolve(
                    import.meta.dirname,
                    'design-security/index.html'
                ),
            },
        },
    },
}));
