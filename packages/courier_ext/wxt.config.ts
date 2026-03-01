import { defineConfig } from 'wxt';

export default defineConfig({
	manifest: {
		name: 'Courier AI',
		description: 'Chat with LLMs using your own API keys',
		permissions: ['storage'],
		externally_connectable: {
			matches: ['https://courier-ai.com/*', 'http://localhost:*/*'],
		},
	},
});
