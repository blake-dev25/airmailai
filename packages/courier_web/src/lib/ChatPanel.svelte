<script lang="ts">
	import { tick } from 'svelte';
	import MarkdownMessage from './MarkdownMessage.svelte';

	interface Message {
		role: 'user' | 'assistant';
		content: string;
	}

	let {
		messages,
		modelName,
		isStreaming = false,
		chatWidth = 100,
		streamError = null,
		systemPrompt = $bindable(),
		onsend,
	}: {
		messages: Message[];
		modelName: string;
		isStreaming?: boolean;
		chatWidth?: number;
		streamError?: string | null;
		systemPrompt: string;
		onsend: (content: string) => void;
	} = $props();

	let systemExpanded = $state(false);
	let inputText = $state('');
	let messagesEl = $state<HTMLElement | null>(null);
	let textareaEl = $state<HTMLTextAreaElement | null>(null);

	$effect(() => {
		// Track last message content so this re-runs on each streaming chunk too
		void messages[messages.length - 1]?.content;
		tick().then(() => {
			if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
		});
	});

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			submit();
		}
	}

	function submit() {
		const text = inputText.trim();
		if (!text || isStreaming) return;
		onsend(text);
		inputText = '';
		if (textareaEl) textareaEl.style.height = '';
	}

	function autoResize(e: Event) {
		const ta = e.target as HTMLTextAreaElement;
		ta.style.height = 'auto';
		ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
	}
</script>

<div class="chat-panel">
	<!-- System prompt -->
	<div class="system-section">
		<button type="button" class="system-header" onclick={() => (systemExpanded = !systemExpanded)}>
			<svg
				class="chevron"
				class:expanded={systemExpanded}
				width="14"
				height="14"
				viewBox="0 0 14 14"
				fill="none"
				aria-hidden="true"
			>
				<path
					d="M3 5l4 4 4-4"
					stroke="currentColor"
					stroke-width="1.5"
					stroke-linecap="round"
					stroke-linejoin="round"
				/>
			</svg>
			<span>System Prompt</span>
			{#if systemPrompt.trim()}
				<span class="prompt-dot" aria-label="System prompt is set"></span>
			{/if}
		</button>
		{#if systemExpanded}
			<div class="system-body">
				<textarea
					class="system-textarea"
					placeholder="Give the model a persona, instructions, or context..."
					bind:value={systemPrompt}
				></textarea>
			</div>
		{/if}
	</div>

	<!-- Messages -->
	<div class="messages" bind:this={messagesEl} style="width: 100%; max-width: {chatWidth}vw; margin-left: auto; margin-right: auto;">
		{#if messages.length === 0}
			<div class="empty-state">
				<svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
					<rect
						x="2"
						y="5"
						width="28"
						height="22"
						rx="3"
						stroke="currentColor"
						stroke-width="1.5"
					/>
					<path d="M2 11l14 9 14-9" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
				</svg>
				<p>Start a conversation</p>
				<p class="sub">Choose a provider and model on the right, then type below.</p>
			</div>
		{:else}
			{#each messages as message, i (i)}
				<div class="message" class:user={message.role === 'user'}>
					{#if message.role === 'user'}
						<div class="bubble">{message.content}</div>
					{:else}
						<div class="bubble">
							<MarkdownMessage content={message.content} />
						</div>
					{/if}
				</div>
			{/each}
		{/if}
	</div>

	<!-- Stream error -->
	{#if streamError}
		<div class="stream-error" role="alert">{streamError}</div>
	{/if}

	<!-- Input -->
	<div class="input-area">
		<textarea
			class="input"
			placeholder="Message {modelName}…"
			rows="1"
			bind:value={inputText}
			bind:this={textareaEl}
			onkeydown={handleKeydown}
			oninput={autoResize}
		></textarea>
		<button type="button" class="send-btn" onclick={submit} disabled={!inputText.trim() || isStreaming} aria-label="Send message">
			<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
				<path
					d="M2 8h12M9 3l5 5-5 5"
					stroke="currentColor"
					stroke-width="1.75"
					stroke-linecap="round"
					stroke-linejoin="round"
				/>
			</svg>
		</button>
	</div>
</div>

<style>
	.chat-panel {
		flex: 1;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		background-color: var(--color-bg);
		min-width: 0;
	}

	/* System Prompt */
	.system-section {
		flex-shrink: 0;
		background-color: var(--color-bg);
		border-bottom: 1px solid var(--color-border);
	}

	.system-header {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		height: 44px;
		padding: 0 16px;
		background: none;
		border: none;
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--color-text);
		cursor: pointer;
		text-align: left;
		transition: color 0.1s;
		box-sizing: border-box;
	}

	.system-header:hover {
		color: var(--color-text);
	}

	.chevron {
		flex-shrink: 0;
		transition: transform 0.2s ease;
	}

	.chevron.expanded {
		transform: rotate(180deg);
	}

	.prompt-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background-color: var(--color-accent);
		flex-shrink: 0;
	}

	.system-body {
		padding: 0 16px 12px;
	}

	.system-textarea {
		width: 100%;
		min-height: 80px;
		max-height: 180px;
		padding: 10px 12px;
		background-color: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		color: var(--color-text);
		font-family: var(--font-sans);
		font-size: 0.8125rem;
		line-height: 1.6;
		resize: vertical;
		box-sizing: border-box;
		transition: border-color 0.15s;
	}

	.system-textarea::placeholder {
		color: var(--color-text);
	}

	.system-textarea:focus {
		outline: none;
		border-color: var(--color-accent);
	}

	/* Messages */
	.messages {
		flex: 1;
		overflow-y: auto;
		padding: 28px 20px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.messages::-webkit-scrollbar {
		display: none;
	}

	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		flex: 1;
		height: 100%;
		gap: 10px;
		color: var(--color-text);
	}

	.empty-state p {
		margin: 0;
		font-size: 0.9375rem;
		font-weight: 500;
		color: var(--color-text);
	}

	.empty-state .sub {
		font-size: 0.8125rem;
		font-weight: 400;
		text-align: center;
		max-width: 280px;
	}

	.message {
		display: flex;
		justify-content: flex-start;
	}

	.message.user {
		justify-content: flex-end;
	}

	.bubble {
		max-width: 70%;
		padding: 10px 14px;
		border-radius: 14px;
		font-size: 0.875rem;
		line-height: 1.65;
		white-space: pre-wrap;
		word-break: break-word;
		background-color: var(--color-surface-sunken);
		color: var(--color-text);
		border-bottom-left-radius: 4px;
	}

	.message.user .bubble {
		background-color: var(--color-accent-2);
		color: var(--color-surface-sunken);
		border-bottom-left-radius: 14px;
		border-bottom-right-radius: 4px;
	}

	/* Input */
	.input-area {
		display: flex;
		align-items: flex-end;
		gap: 8px;
		padding: 12px 16px;
		border-top: 1px solid var(--color-border);
		background-color: var(--color-bg);
		flex-shrink: 0;
	}

	.input {
		flex: 1;
		max-height: 200px;
		padding: 10px 14px;
		background-color: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: 10px;
		color: var(--color-text);
		font-family: var(--font-sans);
		font-size: 0.875rem;
		line-height: 1.5;
		resize: none;
		box-sizing: border-box;
		transition: border-color 0.15s;
	}

	.input::placeholder {
		color: var(--color-text);
	}

	.input:focus {
		outline: none;
		border-color: var(--color-accent);
	}

	.input::-webkit-scrollbar {
		display: none;
	}

	.send-btn {
		width: calc(22px + 0.875rem * 1.5);
		height: calc(22px + 0.875rem * 1.5);
		display: flex;
		align-items: center;
		justify-content: center;
		background-color: var(--color-accent-3, var(--color-accent));
		color: var(--color-bg);
		border: none;
		border-radius: 10px;
		cursor: pointer;
		flex-shrink: 0;
		transition: background-color 0.15s, opacity 0.15s;
	}

	.send-btn:hover:not(:disabled) {
		background-color: var(--color-accent-3-hover, var(--color-accent-hover));
	}

	.send-btn:disabled {
		opacity: 0.35;
		cursor: not-allowed;
	}

	.stream-error {
		flex-shrink: 0;
		padding: 8px 16px;
		font-size: 0.8125rem;
		color: var(--color-accent);
		border-top: 1px solid var(--color-border);
		background-color: var(--color-bg);
	}
</style>
