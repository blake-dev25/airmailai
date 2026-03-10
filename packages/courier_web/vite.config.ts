import { resolve } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
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
