<script lang="ts">
	import ChatPanel from './lib/ChatPanel.svelte';
	import { FONT_SIZES, PROVIDERS } from './lib/constants';
	import { sendToExtension } from './lib/extension';
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

	// Theme
	let theme = $state('airmail-warm');
	$effect(() => {
		document.documentElement.dataset.theme = theme;
	});

	// Font size — default based on screen width
	function getDefaultFontSizeIndex(): number {
		const w = window.screen.width;
		if (w <= 1366) return 3; // 16px — small laptop
		if (w <= 1920) return 4; // 18px — standard
		return 4; // 18px — large/4K
	}
	let fontSizeIndex = $state(getDefaultFontSizeIndex());
	$effect(() => {
		document.documentElement.style.fontSize = `${FONT_SIZES[fontSizeIndex]}px`;
	});

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
	let isStreaming = $state(false);
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
		if (isStreaming) return;

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

		// Add user message, then empty assistant placeholder for streaming
		const userMsg: Message = { role: 'user', content };
		const assistantMsg: Message = { role: 'assistant', content: '' };
		chats = chats.map((c) =>
			c.id === chatId ? { ...c, messages: [...c.messages, userMsg, assistantMsg] } : c
		);

		isStreaming = true;

		// Build message history for the API (exclude the empty placeholder)
		const history = chats.find((c) => c.id === chatId)!.messages.slice(0, -1);
		const apiMessages = systemPrompt.trim()
			? [{ role: 'system' as const, content: systemPrompt }, ...history]
			: history;

		sendToExtension(
			{ provider: providerId, model: modelId, messages: apiMessages, params: { temperature, maxTokens } },
			(chunk) => {
				// Append chunk to the last message in the target chat
				chats = chats.map((c) => {
					if (c.id !== chatId) return c;
					const msgs = [...c.messages];
					msgs[msgs.length - 1] = {
						...msgs[msgs.length - 1],
						content: msgs[msgs.length - 1].content + chunk,
					};
					return { ...c, messages: msgs };
				});
			},
			() => {
				isStreaming = false;
			},
			(msg) => {
				isStreaming = false;
				chats = chats.map((c) => {
					if (c.id !== chatId) return c;
					const msgs = [...c.messages];
					msgs[msgs.length - 1] = { role: 'assistant', content: `Error: ${msg}` };
					return { ...c, messages: msgs };
				});
			},
		);
	}
</script>

<div class="app">
	<Sidebar
		{chats}
		{activeChatId}
		bind:theme
		bind:fontSizeIndex
		onnewchat={newChat}
		onselectchat={(id) => (activeChatId = id)}
	/>
	<ChatPanel messages={activeMessages} modelName={activeModelName} {isStreaming} bind:systemPrompt onsend={sendMessage} />
	<ModelConfig bind:providerId bind:modelId bind:temperature bind:maxTokens />
</div>

<style>
	.app {
		display: flex;
		height: 100vh;
		overflow: hidden;
	}
</style>
