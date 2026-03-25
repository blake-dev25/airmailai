import { defineConfig } from 'wxt';

export default defineConfig({
	vite: () => ({ logLevel: 'warn' }),
	manifest: {
		name: 'CourierAI',
		description: 'Chat with LLMs using your own API keys',
		permissions: ['storage'],
		externally_connectable: {
			matches: ['http://localhost:*/*'],
		},
	},
});
