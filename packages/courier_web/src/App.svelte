<script lang="ts">
	import ChatPanel from './lib/ChatPanel.svelte';
	import { PROVIDERS } from './lib/constants';
	import ModelConfig from './lib/ModelConfig.svelte';
	import Sidebar from './lib/Sidebar.svelte';

	interface Message {
		role: 'user' | 'assistant';
		content: string;
	}

	interface Chat {
		id: string;
		title: string;
		messages: Message[];
		createdAt: number;
	}

	// Model config
	const defaultModel = PROVIDERS[0].models[1]; // Sonnet as default
	let providerId = $state(PROVIDERS[0].id);
	let modelId = $state(defaultModel.id);
	let temperature = $state(defaultModel.params.defaultTemperature);
	let maxTokens = $state(defaultModel.params.defaultMaxTokens);
	let systemPrompt = $state('');

	// Chats
	let chats = $state<Chat[]>([]);
	let activeChatId = $state<string | null>(null);
	let activeMessages = $derived(chats.find((c) => c.id === activeChatId)?.messages ?? []);
	let activeModelName = $derived(
		PROVIDERS.find((p) => p.id === providerId)?.models.find((m) => m.id === modelId)?.name ?? modelId
	);

	function newChat() {
		const id = crypto.randomUUID();
		chats = [{ id, title: 'New Chat', messages: [], createdAt: Date.now() }, ...chats];
		activeChatId = id;
	}

	function sendMessage(content: string) {
		// Auto-create a chat on first message
		let chatId = activeChatId;
		if (!chatId) {
			chatId = crypto.randomUUID();
			chats = [
				{ id: chatId, title: content.slice(0, 40), messages: [], createdAt: Date.now() },
				...chats,
			];
			activeChatId = chatId;
		}

		const userMsg: Message = { role: 'user', content };
		chats = chats.map((c) =>
			c.id === chatId ? { ...c, messages: [...c.messages, userMsg] } : c
		);

		// TODO: connect to extension for actual API calls
		setTimeout(() => {
			const assistantMsg: Message = {
				role: 'assistant',
				content:
					'The Courier AI extension is not yet connected. Install the extension and configure your API keys to start chatting.',
			};
			chats = chats.map((c) =>
				c.id === chatId ? { ...c, messages: [...c.messages, assistantMsg] } : c
			);
		}, 400);
	}
</script>

<div class="app">
	<Sidebar
		{chats}
		{activeChatId}
		onnewchat={newChat}
		onselectchat={(id) => (activeChatId = id)}
		onsettings={() => {}}
	/>
	<ChatPanel messages={activeMessages} modelName={activeModelName} bind:systemPrompt onsend={sendMessage} />
	<ModelConfig bind:providerId bind:modelId bind:temperature bind:maxTokens />
</div>

<style>
	.app {
		display: flex;
		height: 100vh;
		overflow: hidden;
	}
</style>
