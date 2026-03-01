<script lang="ts">
	interface Chat {
		id: string;
		title: string;
		messages: { role: string; content: string }[];
		createdAt: number;
	}

	let {
		chats,
		activeChatId,
		onnewchat,
		onselectchat,
		onsettings,
	}: {
		chats: Chat[];
		activeChatId: string | null;
		onnewchat: () => void;
		onselectchat: (id: string) => void;
		onsettings: () => void;
	} = $props();
</script>

<aside class="sidebar">
	<div class="header">
		<svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
			<rect x="1" y="3" width="16" height="12" rx="2" stroke="currentColor" stroke-width="1.5" />
			<path d="M1 6l8 5 8-5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
		</svg>
		<span class="logo-text">Courier AI</span>
	</div>

	<div class="actions">
		<button type="button" class="new-chat-btn" onclick={onnewchat}>
			<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
				<path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
			</svg>
			New Chat
		</button>
	</div>

	<nav class="history" aria-label="Chat history">
		{#if chats.length === 0}
			<p class="empty">No conversations yet</p>
		{:else}
			{#each chats as chat (chat.id)}
				<button
					type="button"
					class="chat-item"
					class:active={chat.id === activeChatId}
					onclick={() => onselectchat(chat.id)}
					title={chat.title}
				>
					<span class="chat-title">{chat.title}</span>
				</button>
			{/each}
		{/if}
	</nav>

	<div class="footer">
		<button type="button" class="settings-btn" onclick={onsettings}>
			<svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
				<circle cx="7.5" cy="7.5" r="2.5" stroke="currentColor" stroke-width="1.5" />
				<path
					d="M7.5 1v1.5M7.5 12.5V14M1 7.5h1.5M12.5 7.5H14M2.75 2.75l1.06 1.06M11.19 11.19l1.06 1.06M2.75 12.25l1.06-1.06M11.19 3.81l1.06-1.06"
					stroke="currentColor"
					stroke-width="1.5"
					stroke-linecap="round"
				/>
			</svg>
			Settings
		</button>
	</div>
</aside>

<style>
	.sidebar {
		width: 256px;
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		background-color: var(--color-surface);
		border-right: 1px solid var(--color-border);
		overflow: hidden;
	}

	.header {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 18px 16px;
		color: var(--color-text);
		border-bottom: 1px solid var(--color-border);
		flex-shrink: 0;
	}

	.logo-text {
		font-size: 16px;
		font-weight: 600;
		letter-spacing: -0.02em;
	}

	.actions {
		padding: 12px 12px 8px;
		flex-shrink: 0;
	}

	.new-chat-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		width: 100%;
		padding: 9px 12px;
		background-color: var(--color-accent);
		color: #fff;
		border: none;
		border-radius: 8px;
		font-size: 13px;
		font-weight: 500;
		cursor: pointer;
		transition: background-color 0.15s;
	}

	.new-chat-btn:hover {
		background-color: var(--color-accent-hover);
	}

	.history {
		flex: 1;
		overflow-y: auto;
		padding: 4px 8px;
	}

	.history::-webkit-scrollbar {
		width: 3px;
	}

	.history::-webkit-scrollbar-track {
		background: transparent;
	}

	.history::-webkit-scrollbar-thumb {
		background-color: var(--color-border);
		border-radius: 3px;
	}

	.empty {
		padding: 20px 8px;
		font-size: 13px;
		color: var(--color-text-muted);
		text-align: center;
	}

	.chat-item {
		display: block;
		width: 100%;
		padding: 8px 10px;
		background: none;
		border: none;
		border-radius: 6px;
		cursor: pointer;
		text-align: left;
		transition: background-color 0.1s;
		margin-bottom: 1px;
	}

	.chat-item:hover {
		background-color: var(--color-surface-raised);
	}

	.chat-item.active {
		background-color: var(--color-surface-raised);
	}

	.chat-title {
		display: block;
		font-size: 13px;
		color: var(--color-text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.chat-item.active .chat-title {
		color: var(--color-accent);
	}

	.footer {
		padding: 10px 12px;
		border-top: 1px solid var(--color-border);
		flex-shrink: 0;
	}

	.settings-btn {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 8px 10px;
		background: none;
		border: none;
		border-radius: 6px;
		font-size: 13px;
		color: var(--color-text-muted);
		cursor: pointer;
		transition: background-color 0.1s, color 0.1s;
	}

	.settings-btn:hover {
		background-color: var(--color-surface-raised);
		color: var(--color-text);
	}
</style>
