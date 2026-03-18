<script lang="ts">
	import { PROVIDERS, THEMES } from './constants';
	import { checkApiKeys, saveApiKey } from './extension';

	let {
		theme = $bindable(),
		fontSizeIndex = $bindable(),
		chatWidth = $bindable(),
		onclose,
	}: {
		theme: string;
		fontSizeIndex: number;
		chatWidth: number;
		onclose: () => void;
	} = $props();

	let activeTab = $state<'keys' | 'ui' | 'about'>('keys');

	// Input values (cleared after saving — we never display stored keys)
	let keyInputs = $state<Record<string, string>>(
		Object.fromEntries(PROVIDERS.map((p) => [p.id, ''])),
	);

	// Which providers have a key saved in the extension
	let savedKeys = $state<Record<string, boolean>>(
		Object.fromEntries(PROVIDERS.map((p) => [p.id, false])),
	);

	$effect(() => {
		checkApiKeys(PROVIDERS.map((p) => p.id)).then((result) => {
			savedKeys = result;
		});
	});

	async function handleSave(providerId: string) {
		const key = keyInputs[providerId].trim();
		if (!key) return;
		const ok = await saveApiKey(providerId, key);
		if (ok) {
			keyInputs[providerId] = '';
			savedKeys[providerId] = true;
		}
	}
</script>

<div class="backdrop" onclick={onclose} aria-hidden="true"></div>

<div class="popover" role="dialog" aria-label="Settings">
	<div class="tabs">
		<button type="button" class:active={activeTab === 'keys'} onclick={() => (activeTab = 'keys')}>
			API Keys
		</button>
		<button type="button" class:active={activeTab === 'ui'} onclick={() => (activeTab = 'ui')}>
			UI
		</button>
		<button type="button" class:active={activeTab === 'about'} onclick={() => (activeTab = 'about')}>
			About
		</button>
	</div>

	<div class="content">
		{#if activeTab === 'keys'}
			<table class="keys-table">
				<thead>
					<tr>
						<th>Provider</th>
						<th>API Key</th>
						<th>Saved</th>
					</tr>
				</thead>
				<tbody>
					{#each PROVIDERS as provider (provider.id)}
						<tr>
							<td class="provider-name">{provider.name}</td>
							<td class="key-cell">
								<input
									class="key-input"
									type="password"
									placeholder="Paste key…"
									bind:value={keyInputs[provider.id]}
									onkeydown={(e) => { if (e.key === 'Enter') handleSave(provider.id); }}
								/>
								<button
									type="button"
									class="save-btn"
									disabled={!keyInputs[provider.id].trim()}
									onclick={() => handleSave(provider.id)}
								>
									Save
								</button>
							</td>
							<td class="saved-cell">
								{#if savedKeys[provider.id]}
									<svg width="15" height="15" viewBox="0 0 15 15" fill="none" role="img" aria-label="Saved" class="icon-check">
										<path d="M2.5 7.5l3.5 3.5 6.5-6.5" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" />
									</svg>
								{:else}
									<svg width="15" height="15" viewBox="0 0 15 15" fill="none" role="img" aria-label="Not saved" class="icon-x">
										<path d="M3 3l9 9M12 3l-9 9" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" />
									</svg>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{:else if activeTab === 'ui'}
			<div class="row theme-row">
				<label for="theme-select">Theme</label>
				<select id="theme-select" bind:value={theme}>
					{#each THEMES as t (t.id)}
						<option value={t.id}>{t.name}</option>
					{/each}
				</select>
			</div>
			<div class="row">
				<label for="font-size">Text Size</label>
				<input type="range" id="font-size" min="0" max="7" step="1" bind:value={fontSizeIndex} />
				<div class="range-hints">
					<span>Smaller</span>
					<span>Larger</span>
				</div>
			</div>
			<div class="row">
				<label for="chat-width">Chat Width</label>
				<input type="range" id="chat-width" min="33" max="100" step="1" bind:value={chatWidth} />
				<div class="range-hints">
					<span>Narrower</span>
					<span>Wider</span>
				</div>
			</div>
		{:else}
			<p class="todo">TODO — About content coming soon.</p>
		{/if}

	</div>
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 49;
		background-color: oklch(0% 0 0 / 30%);
	}

	.popover {
		position: fixed;
		top: 50%;
		left: 50%;
		translate: -50% -50%;
		width: min(560px, calc(100vw - 48px));
		max-height: calc(100vh - 96px);
		z-index: 50;
		background-color: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: 12px;
		box-shadow: 0 8px 40px oklch(0% 0 0 / 20%);
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.tabs {
		display: flex;
		border-bottom: 1px solid var(--color-border);
	}

	.tabs button {
		flex: 1;
		padding: 12px 16px;
		background: none;
		border: none;
		font-size: 0.8125rem;
		color: var(--color-text);
		cursor: pointer;
		transition: color 0.1s, background-color 0.1s;
	}

	.tabs button:hover {
		color: var(--color-text);
		background-color: var(--color-surface-raised);
	}

	.tabs button.active {
		color: var(--color-accent);
		font-weight: 500;
		box-shadow: inset 0 -2px 0 var(--color-accent);
	}

	.content {
		padding: 20px;
		overflow-y: auto;
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 20px;
	}

	.row {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.row label {
		font-size: 0.8125rem;
		color: var(--color-text);
		font-weight: 500;
	}

	/* Theme row — inline label + select */
	.theme-row {
		flex-direction: row;
		align-items: center;
		justify-content: space-between;
	}

	.theme-row select {
		width: auto;
	}

	.row select {
		width: 100%;
		padding: 7px 10px;
		background-color: var(--color-surface-raised);
		border: 1px solid var(--color-border);
		border-radius: 6px;
		font-size: 0.8125rem;
		color: var(--color-text);
		cursor: pointer;
	}

	/* Text size slider */
	input[type='range'] {
		-webkit-appearance: none;
		appearance: none;
		width: 100%;
		height: 4px;
		background: var(--color-surface-raised);
		border: none;
		border-radius: 4px;
		padding: 0;
		cursor: pointer;
		outline: none;
	}

	input[type='range']::-webkit-slider-thumb {
		-webkit-appearance: none;
		appearance: none;
		width: 16px;
		height: 16px;
		border-radius: 50%;
		background-color: var(--color-accent);
		cursor: pointer;
		transition: background-color 0.15s, transform 0.1s;
	}

	input[type='range']::-webkit-slider-thumb:hover {
		background-color: var(--color-accent-hover);
		transform: scale(1.15);
	}

	input[type='range']::-moz-range-thumb {
		width: 16px;
		height: 16px;
		border: none;
		border-radius: 50%;
		background-color: var(--color-accent);
		cursor: pointer;
	}

	.range-hints {
		display: flex;
		justify-content: space-between;
		font-size: 0.6875rem;
		color: var(--color-text);
		margin-top: -4px;
	}

	/* API Keys table */
	.keys-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.8125rem;
	}

	.keys-table th {
		text-align: left;
		font-weight: 500;
		color: var(--color-text);
		padding: 0 12px 10px;
		border-bottom: 1px solid var(--color-border);
	}

	.keys-table th:last-child,
	.keys-table td:last-child {
		text-align: center;
	}

	.keys-table td {
		padding: 8px 12px;
		border-bottom: 1px solid var(--color-border);
		color: var(--color-text);
		vertical-align: middle;
	}

	.keys-table tbody tr:last-child td {
		border-bottom: none;
	}

	.provider-name {
		white-space: nowrap;
		font-weight: 500;
		width: 100px;
	}

	.key-cell {
		display: flex;
		gap: 6px;
		align-items: center;
	}

	.save-btn {
		flex-shrink: 0;
		padding: 5px 10px;
		background-color: var(--color-accent);
		color: var(--color-bg);
		border: none;
		border-radius: 6px;
		font-size: 0.75rem;
		font-weight: 500;
		cursor: pointer;
		transition: background-color 0.15s, opacity 0.15s;
		white-space: nowrap;
	}

	.save-btn:hover:not(:disabled) {
		background-color: var(--color-accent-hover);
	}

	.save-btn:disabled {
		opacity: 0.35;
		cursor: not-allowed;
	}

	.key-input {
		flex: 1;
		min-width: 0;
		padding: 6px 10px;
		background-color: var(--color-surface-raised);
		border: 1px solid var(--color-border);
		border-radius: 6px;
		font-size: 0.8125rem;
		color: var(--color-text);
		font-family: var(--font-mono);
		box-sizing: border-box;
		outline: none;
		transition: border-color 0.15s;
	}

	.key-input:focus {
		border-color: var(--color-accent);
	}

	.key-input::placeholder {
		font-family: var(--font-sans);
		color: var(--color-text-muted);
	}

	.saved-cell {
		width: 48px;
	}

	.icon-check {
		color: #4caf6e;
	}

	.icon-x {
		color: var(--color-text-muted);
	}

	.todo {
		font-size: 0.8125rem;
		color: var(--color-text);
		margin: 0;
		padding: 4px 0;
	}
</style>
