import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

function readVersion(): string {
    try {
        return readFileSync(join(__dirname, '../../VERSION'), 'utf-8').trim();
    } catch {
        return '0.0.0.0';
    }
}

export default defineConfig({
    logLevel: 'warn',
    define: {
        __APP_VERSION__: JSON.stringify(readVersion()),
    },
    plugins: [tailwindcss(), svelte()],
    build: {
        rollupOptions: {
            input: {
                main: resolve(__dirname, 'index.html'),
                app: resolve(__dirname, 'app/index.html'),
            },
        },
    },
});
