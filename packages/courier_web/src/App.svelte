<script lang="ts">
	import { untrack } from 'svelte';
	import ChatPanel from './lib/ChatPanel.svelte';
	import { FONT_SIZES, PROVIDERS } from './lib/constants';
	import ExtensionPrompt from './lib/ExtensionPrompt.svelte';
	import {
		deleteChat,
		loadChats,
		loadSettings,
		saveChat,
		saveSettings,
		sendToExtension,
		waitForExtension,
	} from './lib/extension';
	import ModelConfig from './lib/ModelConfig.svelte';
	import Sidebar from './lib/Sidebar.svelte';

	const LOG = '[courier:web]';
	console.log(LOG, 'page load', { screen: `${window.screen.width}x${window.screen.height}`, time: new Date().toISOString() });

	interface Message {
		role: 'user' | 'assistant';
		content: string;
	}

	interface Chat {
		id: string;
		title: string;
		messages: Message[];
		createdAt: number;
		systemPrompt: string;
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

	// Chat width — 33 to 100 (vw), default unconstrained
	let chatWidth = $state(100);

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
	let streamError = $state<string | null>(null);
	let activeMessages = $derived(chats.find((c) => c.id === activeChatId)?.messages ?? []);
	let activeModelName = $derived(
		PROVIDERS.find((p) => p.id === providerId)?.models.find((m) => m.id === modelId)?.name ?? modelId
	);

	// --- Storage ---

	let settingsLoaded = $state(false);
	let extensionDetected = $state<boolean | null>(null);

	// Load settings + chats on mount, waiting for extension discovery
	waitForExtension().then(async (detected) => {
		extensionDetected = detected;
		console.log(LOG, 'extension detected:', detected);
		const [settings, storedChats] = await Promise.all([loadSettings(), loadChats()]);

		console.log(LOG, 'settings loaded', settings);

		if (settings.theme) theme = settings.theme;
		if (settings.fontSizeIndex !== undefined) fontSizeIndex = settings.fontSizeIndex;
		if (settings.chatWidth !== undefined) chatWidth = settings.chatWidth;
		if (settings.providerId) providerId = settings.providerId;
		if (settings.modelId) modelId = settings.modelId;
		if (settings.temperature !== undefined) temperature = settings.temperature;
		if (settings.maxTokens !== undefined) maxTokens = settings.maxTokens;

		chats = storedChats.sort((a, b) => b.createdAt - a.createdAt);
		console.log(LOG, 'chats loaded', `${chats.length} chats`);

		settingsLoaded = true;
	});

	// Debounced save — fires 300ms after any settings change (but not during initial load)
	$effect(() => {
		const snapshot = { theme, fontSizeIndex, chatWidth, providerId, modelId, temperature, maxTokens };
		if (!untrack(() => settingsLoaded)) return;
		const timer = setTimeout(() => {
			console.log(LOG, 'settings save (debounced)', snapshot);
			saveSettings(snapshot);
		}, 300);
		return () => clearTimeout(timer);
	});

	// --- Chat actions ---

	function newChat() {
		const id = crypto.randomUUID();
		console.log(LOG, 'new chat', id);
		chats = [{ id, title: 'New Chat', messages: [], createdAt: Date.now(), systemPrompt: '' }, ...chats];
		activeChatId = id;
		systemPrompt = '';
	}

	function selectChat(id: string) {
		console.log(LOG, 'select chat', id);
		activeChatId = id;
		systemPrompt = chats.find((c) => c.id === id)?.systemPrompt ?? '';
	}

	function removeChat(id: string) {
		console.log(LOG, 'remove chat', id);
		chats = chats.filter((c) => c.id !== id);
		if (activeChatId === id) {
			activeChatId = chats[0]?.id ?? null;
			systemPrompt = chats[0]?.systemPrompt ?? '';
		}
		deleteChat(id).catch(console.error);
	}

	function sendMessage(content: string) {
		if (isStreaming) return;
		streamError = null;
		console.log(LOG, 'send message', { provider: providerId, model: modelId, contentLength: content.length, existingChat: activeChatId });

		// Auto-create a chat on first message
		let chatId = activeChatId;
		if (!chatId) {
			chatId = crypto.randomUUID();
			chats = [
				{
					id: chatId,
					title: content.slice(0, 40),
					messages: [],
					createdAt: Date.now(),
					systemPrompt,
				},
				...chats,
			];
			activeChatId = chatId;
		} else {
			// Update systemPrompt and rename if this is the first message
			chats = chats.map((c) => {
				if (c.id !== chatId) return c;
				return { ...c, systemPrompt, ...(c.messages.length === 0 ? { title: content.slice(0, 40) } : {}) };
			});
		}

		// Add user message, then empty assistant placeholder for streaming
		const userMsg: Message = { role: 'user', content };
		const assistantMsg: Message = { role: 'assistant', content: '' };
		chats = chats.map((c) =>
			c.id === chatId ? { ...c, messages: [...c.messages, userMsg, assistantMsg] } : c
		);

		isStreaming = true;

		// Save after adding user message (exclude empty assistant placeholder)
		const chatSnapshot = chats.find((c) => c.id === chatId)!;
		saveChat({ ...chatSnapshot, messages: chatSnapshot.messages.slice(0, -1) }).catch(
			console.error
		);

		// Build message history for the API (exclude the empty placeholder)
		const history = chatSnapshot.messages.slice(0, -1);
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
				const done = chats.find((c) => c.id === chatId);
				if (done) saveChat({ ...done }).catch(console.error);
			},
			(msg) => {
				isStreaming = false;
				streamError = msg;
				// Pop the empty assistant placeholder — DB already has the correct state
				// (user message was saved before streaming started)
				chats = chats.map((c) =>
					c.id === chatId ? { ...c, messages: c.messages.slice(0, -1) } : c
				);
			},
		);
	}
</script>

{#if extensionDetected === false}
	<ExtensionPrompt />
{/if}

<div class="app">
	<Sidebar
		{chats}
		{activeChatId}
		bind:theme
		bind:fontSizeIndex
		bind:chatWidth
		onnewchat={newChat}
		onselectchat={selectChat}
		ondeletechat={removeChat}
	/>
	<ChatPanel messages={activeMessages} modelName={activeModelName} {isStreaming} {streamError} {chatWidth} bind:systemPrompt onsend={sendMessage} />
	<ModelConfig bind:providerId bind:modelId bind:temperature bind:maxTokens />
</div>

<style>
	.app {
		display: flex;
		height: 100vh;
		overflow: hidden;
	}
</style>
