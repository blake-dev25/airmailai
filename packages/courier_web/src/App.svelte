<script lang="ts">
	import type { ChatMeta, StoredChat } from '@courier/shared';
	import { untrack } from 'svelte';
	import ChatPanel from './lib/ChatPanel.svelte';
	import { FONT_SIZES, PROVIDERS } from './lib/constants';
	import ExtensionPrompt from './lib/ExtensionPrompt.svelte';
	import {
		deleteChat,
		loadChat,
		loadChatMetas,
		loadChatsByIds,
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
		providerId: string;
		modelId: string;
		temperature: number;
		maxTokens: number;
		tokens?: { input: number; output: number };
	}

	const PAGE_SIZE = 40;

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
	// All chat metas sorted newest-first — used to track total count for pagination
	let allMetas = $state<ChatMeta[]>([]);
	let hasMoreChats = $derived(chats.length < allMetas.length);
	let isLoadingMore = $state(false);
	let activeChatId = $state<string | null>(null);
	let isStreaming = $state(false);
	let streamError = $state<string | null>(null);
	let activeMessages = $derived(chats.find((c) => c.id === activeChatId)?.messages ?? []);
	let activeModelName = $derived(
		PROVIDERS.find((p) => p.id === providerId)?.models.find((m) => m.id === modelId)?.name ?? modelId
	);
	let activeTokens = $derived(chats.find((c) => c.id === activeChatId)?.tokens ?? null);

	// --- Storage ---

	let settingsLoaded = $state(false);
	let extensionDetected = $state<boolean | null>(null);
	let chatLoading = $state(false);

	// Tracks which chat IDs have full messages loaded in memory
	const loadedChatIds = new Set<string>();

	waitForExtension().then(async (detected) => {
		extensionDetected = detected;
		console.log(LOG, 'extension detected:', detected);

		const [settings, metas] = await Promise.all([loadSettings(), loadChatMetas()]);

		console.log(LOG, 'settings loaded', settings);
		if (settings.theme) theme = settings.theme;
		if (settings.fontSizeIndex !== undefined) fontSizeIndex = settings.fontSizeIndex;
		if (settings.chatWidth !== undefined) chatWidth = settings.chatWidth;
		if (settings.providerId) providerId = settings.providerId;
		if (settings.modelId) modelId = settings.modelId;
		if (settings.temperature !== undefined) temperature = settings.temperature;
		if (settings.maxTokens !== undefined) maxTokens = settings.maxTokens;

		settingsLoaded = true;

		const sorted = metas.sort((a, b) => b.createdAt - a.createdAt);
		allMetas = sorted;
		console.log(LOG, 'chat metas loaded', `${sorted.length} chats`);

		// Load first page of full chats
		const firstIds = sorted.slice(0, PAGE_SIZE).map((t) => t.id);
		if (firstIds.length > 0) {
			const fullChats = await loadChatsByIds(firstIds);
			const byId = new Map(fullChats.map((c) => [c.id, c]));
			const metaById = new Map(sorted.map((t) => [t.id, t]));
			chats = firstIds
				.map((id) => {
					const stored = byId.get(id);
					const meta = metaById.get(id);
					if (!stored || !meta) return null;
					return { ...meta, messages: stored.messages, ...(stored.tokens ? { tokens: stored.tokens } : {}) };
				})
				.filter((c): c is Chat => c !== null);
			for (const id of firstIds) loadedChatIds.add(id);
			console.log(LOG, 'first page loaded', `${chats.length} chats`);
		}
	});

	async function loadMoreChats() {
		if (isLoadingMore || !hasMoreChats) return;
		isLoadingMore = true;
		// chats.length == number loaded so far == offset into allMetas
		const nextIds = allMetas.slice(chats.length, chats.length + PAGE_SIZE).map((t) => t.id);
		const fullChats = await loadChatsByIds(nextIds);
		const byId = new Map(fullChats.map((c) => [c.id, c]));
		const metaById = new Map(allMetas.map((t) => [t.id, t]));
		const newChats = nextIds
			.map((id) => {
				const stored = byId.get(id);
				const meta = metaById.get(id);
				if (!stored || !meta) return null;
				return { ...meta, messages: stored.messages, ...(stored.tokens ? { tokens: stored.tokens } : {}) };
			})
			.filter((c): c is Chat => c !== null);
		chats = [...chats, ...newChats];
		for (const id of nextIds) loadedChatIds.add(id);
		console.log(LOG, 'loaded more chats', `${newChats.length} chats, total ${chats.length}`);
		isLoadingMore = false;
	}

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

	function chatToStored(chat: Chat, messages = chat.messages): StoredChat {
		return { id: chat.id, messages, ...(chat.tokens ? { tokens: chat.tokens } : {}) };
	}
	function chatToMeta(chat: Chat): ChatMeta {
		return { id: chat.id, title: chat.title, createdAt: chat.createdAt, providerId: chat.providerId, modelId: chat.modelId, temperature: chat.temperature, maxTokens: chat.maxTokens, systemPrompt: chat.systemPrompt };
	}

	// --- Chat actions ---

	function newChat() {
		const id = crypto.randomUUID();
		const now = Date.now();
		console.log(LOG, 'new chat', id);
		chats = [{ id, title: 'New Chat', messages: [], createdAt: now, systemPrompt, providerId, modelId, temperature, maxTokens }, ...chats];
		allMetas = [{ id, title: 'New Chat', createdAt: now, providerId, modelId, temperature, maxTokens, systemPrompt }, ...allMetas];
		loadedChatIds.add(id);
		activeChatId = id;
	}

	async function selectChat(id: string) {
		console.log(LOG, 'select chat', id);
		activeChatId = id;

		// Restore model config + system prompt from saved meta
		const meta = allMetas.find((t) => t.id === id);
		if (meta) {
			providerId = meta.providerId;
			modelId = meta.modelId;
			temperature = meta.temperature;
			maxTokens = meta.maxTokens;
			systemPrompt = meta.systemPrompt;
		}

		if (loadedChatIds.has(id)) return;

		// Background load hasn't finished yet — fetch this chat on demand
		chatLoading = true;
		const full = await loadChat(id);
		chatLoading = false;

		if (full && activeChatId === id) {
			loadedChatIds.add(full.id);
			chats = chats.map((c) => (c.id === id ? { ...c, messages: full.messages, tokens: full.tokens } : c));
		}
	}

	function removeChat(id: string) {
		console.log(LOG, 'remove chat', id);
		loadedChatIds.delete(id);
		chats = chats.filter((c) => c.id !== id);
		allMetas = allMetas.filter((t) => t.id !== id);
		if (activeChatId === id) {
			activeChatId = null;
			systemPrompt = '';
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
			const now = Date.now();
			const title = content.slice(0, 40);
			chats = [{ id: chatId, title, messages: [], createdAt: now, systemPrompt, providerId, modelId, temperature, maxTokens }, ...chats];
			allMetas = [{ id: chatId, title, createdAt: now, providerId, modelId, temperature, maxTokens, systemPrompt }, ...allMetas];
			loadedChatIds.add(chatId);
			activeChatId = chatId;
		} else {
			// Update config and rename if this is the first message
			const isFirst = (chats.find((c) => c.id === chatId)?.messages.length ?? 0) === 0;
			chats = chats.map((c) => {
				if (c.id !== chatId) return c;
				return { ...c, systemPrompt, providerId, modelId, temperature, maxTokens, ...(isFirst ? { title: content.slice(0, 40) } : {}) };
			});
			allMetas = allMetas.map((t) => {
				if (t.id !== chatId) return t;
				return { ...t, providerId, modelId, temperature, maxTokens, systemPrompt, ...(isFirst ? { title: content.slice(0, 40) } : {}) };
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
		saveChat(chatToStored(chatSnapshot, chatSnapshot.messages.slice(0, -1)), chatToMeta(chatSnapshot)).catch(console.error);

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
			(usage) => {
				isStreaming = false;
				chats = chats.map((c) => {
					if (c.id !== chatId) return c;
					return usage ? { ...c, tokens: { input: usage.inputTokens, output: usage.outputTokens } } : c;
				});
				const done = chats.find((c) => c.id === chatId);
				if (done) saveChat(chatToStored(done), chatToMeta(done)).catch(console.error);
			},
			(msg) => {
				isStreaming = false;
				streamError = `API Error: ${msg}`;
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
		{hasMoreChats}
		{isLoadingMore}
		bind:theme
		bind:fontSizeIndex
		bind:chatWidth
		onnewchat={newChat}
		onselectchat={selectChat}
		ondeletechat={removeChat}
		onloadmore={loadMoreChats}
	/>
	<ChatPanel messages={activeMessages} modelName={activeModelName} {isStreaming} {streamError} {chatWidth} loading={chatLoading} bind:systemPrompt onsend={sendMessage} />
	<ModelConfig bind:providerId bind:modelId bind:temperature bind:maxTokens tokens={activeTokens} />
</div>

<style>
	.app {
		display: flex;
		height: 100vh;
		overflow: hidden;
	}
</style>
