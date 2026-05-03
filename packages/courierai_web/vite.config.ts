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

export default defineConfig({
    logLevel: 'warn',
    publicDir: 'static',
    define: {
        __APP_VERSION__: JSON.stringify(readVersion()),
    },
    plugins: [tailwindcss(), svelte()],
    build: {
        rollupOptions: {
            input: {
                main: resolve(__dirname, 'index.html'),
                app: resolve(__dirname, 'app/index.html'),
                faq: resolve(__dirname, 'faq/index.html'),
            },
        },
    },
});
