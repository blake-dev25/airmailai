<script lang="ts">
	import { THEMES } from './constants';

	let {
		theme = $bindable(),
		fontSizeIndex = $bindable(),
		onclose,
	}: {
		theme: string;
		fontSizeIndex: number;
		onclose: () => void;
	} = $props();

	let activeTab = $state<'ui' | 'about'>('ui');
</script>

<div class="backdrop" onclick={onclose} aria-hidden="true"></div>

<div class="popover" role="dialog" aria-label="Settings">
	<div class="tabs">
		<button type="button" class:active={activeTab === 'ui'} onclick={() => (activeTab = 'ui')}>
			UI
		</button>
		<button type="button" class:active={activeTab === 'about'} onclick={() => (activeTab = 'about')}>
			About
		</button>
	</div>

	<div class="content">
		{#if activeTab === 'ui'}
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

	.todo {
		font-size: 0.8125rem;
		color: var(--color-text);
		margin: 0;
		padding: 4px 0;
	}
</style>
