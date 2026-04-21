<script lang="ts">
	import type { Attachment } from '@courier/shared';
	import { tick, untrack } from 'svelte';
	import MarkdownMessage from './MarkdownMessage.svelte';

	interface Message {
		role: 'user' | 'assistant';
		content: string;
		thinking?: string;
		attachments?: Attachment[];
	}

	let {
		messages,
		modelName,
		isStreaming = false,
		chatWidth = 100,
		streamError = null,
		loading = false,
		smoothText = true,
		systemPrompt = $bindable(),
		onsend,
	}: {
		messages: Message[];
		modelName: string;
		isStreaming?: boolean;
		chatWidth?: number;
		streamError?: string | null;
		loading?: boolean;
		smoothText?: boolean;
		systemPrompt: string;
		onsend: (content: string, attachments?: Attachment[]) => void;
	} = $props();

	let systemExpanded = $state(false);
	let expandedThinking = $state(new Set<number>());
	let inputText = $state('');
	let messagesEl = $state<HTMLElement | null>(null);
	let textareaEl = $state<HTMLTextAreaElement | null>(null);
	let fileInputEl = $state<HTMLInputElement | null>(null);
	let isAtBottom = $state(true);
	let pendingAttachments = $state<Attachment[]>([]);

	const MAX_ATTACHMENTS = 20;

	const DRAIN_CHARS_PER_SEC = 60;

	let displayContent = $state('');
	let rafTarget = '';
	let rafId: number | null = null;
	let rafLastTime = 0;
	let rafAccum = 0;

	function rafTick(now: DOMHighResTimeStamp) {
		if (displayContent.length > rafTarget.length) {
			displayContent = rafTarget;
			rafId = null;
			rafLastTime = 0;
			rafAccum = 0;
			return;
		}
		if (displayContent.length < rafTarget.length) {
			if (rafLastTime > 0) {
				rafAccum += (now - rafLastTime) / 1000 * DRAIN_CHARS_PER_SEC;
				const step = Math.floor(rafAccum);
				rafAccum -= step;
				if (step > 0) {
					displayContent = rafTarget.slice(0, Math.min(rafTarget.length, displayContent.length + step));
				}
			}
			rafLastTime = now;
			rafId = requestAnimationFrame(rafTick);
		} else {
			rafId = null;
			rafLastTime = 0;
			rafAccum = 0;
		}
	}

	$effect(() => {
		void displayContent;
		tick().then(() => {
			if (messagesEl && untrack(() => isAtBottom)) messagesEl.scrollTop = messagesEl.scrollHeight;
		});
	});

	$effect(() => {
		const raw = messages[messages.length - 1]?.content ?? '';

		if (!smoothText) {
			if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
			rafLastTime = 0;
			rafAccum = 0;
			displayContent = raw;
			rafTarget = raw;
			return;
		}

		// Content grew from a non-empty target — streaming continuation, keep draining.
		const grew = raw.length >= rafTarget.length && raw.startsWith(rafTarget) && rafTarget.length > 0;
		// rafTarget is empty — only drain if a stream is actively running (first chunk).
		const firstChunk = rafTarget.length === 0 && untrack(() => isStreaming);

		if (grew || firstChunk) {
			rafTarget = raw;
			if (rafId === null && displayContent.length < rafTarget.length) {
				rafId = requestAnimationFrame(rafTick);
			}
		} else {
			// Content changed to something else (chat switch, error reset, page load) — flush.
			if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
			rafLastTime = 0;
			rafAccum = 0;
			displayContent = raw;
			rafTarget = raw;
			isAtBottom = true;
		}

		return () => {
			if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
		};
	});

	function handleMessagesScroll() {
		if (!messagesEl) return;
		const { scrollTop, scrollHeight, clientHeight } = messagesEl;
		isAtBottom = scrollHeight - scrollTop - clientHeight < 80;
	}

	function scrollToBottom() {
		if (!messagesEl) return;
		isAtBottom = true;
		messagesEl.scrollTop = messagesEl.scrollHeight;
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			submit();
		}
	}

	function submit() {
		const text = inputText.trim();
		if ((!text && !pendingAttachments.length) || isStreaming) return;
		isAtBottom = true;
		const atts = pendingAttachments;
		pendingAttachments = [];
		onsend(text, atts.length ? atts : undefined);
		inputText = '';
		if (textareaEl) textareaEl.style.height = '';
	}

	function openFilePicker() {
		fileInputEl?.click();
	}

	function handleFileChange(e: Event) {
		const files = Array.from((e.target as HTMLInputElement).files ?? []);
		if (!fileInputEl) return;
		fileInputEl.value = '';
		if (!files.length) return;

		const slots = MAX_ATTACHMENTS - pendingAttachments.length;
		const toAdd = files.slice(0, slots);

		for (const file of toAdd) {
			const reader = new FileReader();
			reader.onload = () => {
				const dataUrl = reader.result as string;
				const comma = dataUrl.indexOf(',');
				const data = dataUrl.slice(comma + 1);
				pendingAttachments = [...pendingAttachments, { name: file.name, mediaType: file.type, data }];
			};
			reader.readAsDataURL(file);
		}
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
	<div class="messages-wrapper">
	<div class="messages" bind:this={messagesEl} onscroll={handleMessagesScroll}>
	<div class="messages-inner" style="max-width: {chatWidth}vw;">
		{#if loading}
			<div class="empty-state">
				<p class="sub">Loading…</p>
			</div>
		{:else if messages.length === 0}
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
						<div class="user-group">
							{#if message.attachments?.length}
								<div class="attachment-chips">
									{#each message.attachments as att}
										<span class="attachment-chip">{att.name}</span>
									{/each}
								</div>
							{/if}
							{#if message.content}
								<div class="bubble">{message.content}</div>
							{/if}
						</div>
					{:else}
						{@const msgContent = (i === messages.length - 1 && message.role === 'assistant' && (isStreaming || displayContent !== message.content)) ? displayContent : message.content}
						<div class="assistant-group">
							{#if isStreaming && i === messages.length - 1 && !message.content && !message.thinking}
								<div class="waiting-spinner">
									<svg class="spinner" width="16" height="16" viewBox="0 0 12 12" fill="none" aria-hidden="true">
										<circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.5" stroke-dasharray="18 8" stroke-linecap="round" />
									</svg>
								</div>
							{/if}
							{#if message.thinking}
								<div class="thinking-block">
									<button
										type="button"
										class="thinking-toggle"
										onclick={() => {
											const next = new Set(expandedThinking);
											if (next.has(i)) next.delete(i);
											else next.add(i);
											expandedThinking = next;
										}}
									>
										{#if isStreaming && i === messages.length - 1 && !message.content}
											<svg class="spinner" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
												<circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.5" stroke-dasharray="18 8" stroke-linecap="round" />
											</svg>
										{/if}
										<span>Thinking</span>
										<svg
											class="thinking-chevron"
											class:expanded={expandedThinking.has(i)}
											width="12"
											height="12"
											viewBox="0 0 12 12"
											fill="none"
											aria-hidden="true"
										>
											<path d="M4.5 2.5l3.5 3.5-3.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
										</svg>
									</button>
									{#if expandedThinking.has(i)}
										<div class="thinking-content">{message.thinking}</div>
									{/if}
								</div>
							{/if}
							{#if msgContent}
								<div class="bubble">
									<MarkdownMessage content={msgContent} />
								</div>
							{/if}
						</div>
					{/if}
				</div>
			{/each}
		{/if}
	</div>
	</div>
	{#if !isAtBottom}
		<button type="button" class="scroll-bottom-btn" onclick={scrollToBottom} aria-label="Scroll to bottom">
			<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
				<path d="M3 5l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
			</svg>
		</button>
	{/if}
	</div>

	<!-- Stream error -->
	{#if streamError}
		<div class="stream-error" role="alert">{streamError}</div>
	{/if}

	<!-- Input -->
	<div class="input-wrapper">
		{#if pendingAttachments.length}
			<div class="file-tab-row">
				{#each pendingAttachments as att, i}
					<div class="file-tab">
						<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
							<path d="M2 1.5h5.5L10 4v6.5H2V1.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
							<path d="M7.5 1.5V4H10" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
						</svg>
						<span class="file-tab-name">{att.name}</span>
						<button type="button" class="file-tab-remove" onclick={() => pendingAttachments = pendingAttachments.filter((_, j) => j !== i)} aria-label="Remove attachment">
							<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
								<path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
							</svg>
						</button>
					</div>
				{/each}
			</div>
		{/if}
		<div class="input-area">
			<input
				type="file"
				accept=".pdf,image/*"
				multiple
				class="file-input"
				bind:this={fileInputEl}
				onchange={handleFileChange}
			/>
			<button type="button" class="attach-btn" onclick={openFilePicker} disabled={isStreaming || pendingAttachments.length >= MAX_ATTACHMENTS} aria-label="Attach file">
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
					<path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>
				</svg>
			</button>
			<textarea
				class="input"
				placeholder="Message {modelName}…"
				rows="1"
				bind:value={inputText}
				bind:this={textareaEl}
				onkeydown={handleKeydown}
				oninput={autoResize}
			></textarea>
			<button type="button" class="send-btn" onclick={submit} disabled={(!inputText.trim() && !pendingAttachments.length) || isStreaming} aria-label="Send message">
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
	.messages-wrapper {
		flex: 1;
		position: relative;
		min-height: 0;
	}

	.scroll-bottom-btn {
		position: absolute;
		bottom: 16px;
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 30px;
		background-color: var(--color-surface-sunken);
		border: 1px solid var(--color-border);
		border-radius: 50%;
		color: var(--color-text);
		cursor: pointer;
		z-index: 5;
		transition: background-color 0.15s;
		animation: fadeUp 0.15s ease;
	}

	.scroll-bottom-btn:hover {
		background-color: var(--color-border);
	}

	@keyframes fadeUp {
		from { opacity: 0; transform: translateX(-50%) translateY(6px); }
		to { opacity: 1; transform: translateX(-50%) translateY(0); }
	}

	.messages {
		height: 100%;
		overflow-y: auto;
	}

	.messages-inner {
		margin: 0 auto;
		padding: 28px 20px;
		display: flex;
		flex-direction: column;
		gap: 16px;
		min-height: 100%;
		box-sizing: border-box;
	}

	.messages::-webkit-scrollbar {
		width: 3px;
	}

	.messages::-webkit-scrollbar-track {
		background: transparent;
	}

	.messages::-webkit-scrollbar-thumb {
		background-color: var(--color-border);
		border-radius: 3px;
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

	.user-group .bubble {
		max-width: 100%;
		background-color: var(--color-accent-2);
		color: var(--color-surface-sunken);
		border-bottom-left-radius: 14px;
		border-bottom-right-radius: 4px;
	}

	.assistant-group .bubble {
		max-width: 100%;
	}

	/* Assistant message group (thinking + bubble stacked) */
	.assistant-group {
		display: flex;
		flex-direction: column;
		gap: 8px;
		max-width: 70%;
	}

	/* Thinking block */
	.thinking-block {
		border: 1px solid var(--color-border);
		border-radius: 8px;
		overflow: hidden;
	}

	.thinking-toggle {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 6px 10px;
		background: none;
		border: none;
		color: var(--color-text);
		font-family: var(--font-sans);
		font-size: 0.75rem;
		font-weight: 500;
		opacity: 0.6;
		cursor: pointer;
		text-align: left;
		transition: opacity 0.15s;
	}

	.thinking-toggle:hover {
		opacity: 1;
	}

	.thinking-chevron {
		flex-shrink: 0;
		transition: transform 0.2s ease;
	}

	.thinking-chevron.expanded {
		transform: rotate(90deg);
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	.spinner {
		flex-shrink: 0;
		animation: spin 0.8s linear infinite;
		transform-box: fill-box;
		transform-origin: center;
	}

	.thinking-content {
		padding: 8px 10px 10px;
		border-top: 1px solid var(--color-border);
		font-size: 0.75rem;
		line-height: 1.6;
		color: var(--color-text);
		opacity: 0.7;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.waiting-spinner {
		display: flex;
		align-items: center;
		padding: 10px 14px;
		color: var(--color-text-muted);
	}

	/* User group (attachment chips + bubble) */
	.user-group {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 6px;
		max-width: 70%;
	}

	.attachment-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		justify-content: flex-end;
	}

	.attachment-chip {
		display: inline-flex;
		align-items: center;
		padding: 4px 10px;
		background-color: var(--color-accent-2);
		color: var(--color-surface-sunken);
		border-radius: 8px;
		font-size: 0.75rem;
		font-weight: 500;
		max-width: 240px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* Input wrapper (file tab + input row) */
	.input-wrapper {
		flex-shrink: 0;
		border-top: 1px solid var(--color-border);
		background-color: var(--color-bg);
	}

	/* File tab */
	.file-tab-row {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		padding: 8px 16px 0;
	}

	.file-tab {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 5px 8px 5px 10px;
		background-color: var(--color-surface-sunken);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		font-size: 0.75rem;
		color: var(--color-text);
		max-width: 240px;
	}

	.file-tab-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 180px;
	}

	.file-tab-remove {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 16px;
		height: 16px;
		background: none;
		border: none;
		padding: 0;
		color: var(--color-text);
		opacity: 0.5;
		cursor: pointer;
		flex-shrink: 0;
		transition: opacity 0.15s;
	}

	.file-tab-remove:hover {
		opacity: 1;
	}

	/* Input */
	.input-area {
		display: flex;
		align-items: flex-end;
		gap: 8px;
		padding: 12px 16px;
		background-color: var(--color-bg);
		flex-shrink: 0;
	}

	.file-input {
		display: none;
	}

	.attach-btn {
		width: calc(22px + 0.875rem * 1.5);
		height: calc(22px + 0.875rem * 1.5);
		display: flex;
		align-items: center;
		justify-content: center;
		background-color: var(--color-surface-sunken);
		color: var(--color-text);
		border: 1px solid var(--color-border);
		border-radius: 10px;
		cursor: pointer;
		flex-shrink: 0;
		transition: background-color 0.15s, opacity 0.15s;
	}

	.attach-btn:hover:not(:disabled) {
		background-color: var(--color-border);
	}

	.attach-btn:disabled {
		opacity: 0.35;
		cursor: not-allowed;
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
