import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

function readVersion(): string {
    for (const name of ['VERSION_NAME', 'VERSION']) {
        try {
            return readFileSync(join(__dirname, '../..', name), 'utf-8').trim();
        } catch {}
    }
    return '0.0.0.1';
}

// Verbosity is driven by BUILD_VERBOSE so the default `bun run build` stays
// quiet on warnings (only errors surface), and `bun run build:verbose` opts
// back into the full Vite + Rolldown warning stream when debugging.
const verbose = !!process.env.BUILD_VERBOSE;

export default defineConfig({
    logLevel: verbose ? 'info' : 'error',
    publicDir: 'static',
    define: {
        __APP_VERSION__: JSON.stringify(readVersion()),
    },
    plugins: [tailwindcss(), svelte()],
    build: {
        rollupOptions: {
            ...(verbose ? {} : { onwarn: () => {} }),
            input: {
                main: resolve(__dirname, 'index.html'),
                app: resolve(__dirname, 'app/index.html'),
                faq: resolve(__dirname, 'faq/index.html'),
            },
        },
    },
});
