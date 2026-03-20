import { defineConfig } from 'wxt';

export default defineConfig({
	manifest: {
		name: 'CourierAI',
		description: 'Chat with LLMs using your own API keys',
		permissions: ['storage'],
		externally_connectable: {
			matches: ['http://localhost:*/*'],
		},
	},
});
