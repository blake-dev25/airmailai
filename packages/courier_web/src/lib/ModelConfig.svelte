<script lang="ts">
	import { untrack } from 'svelte';
	import { PROVIDERS } from './constants';

	let {
		providerId = $bindable(),
		modelId = $bindable(),
		temperature = $bindable(),
		maxTokens = $bindable(),
	}: {
		providerId: string;
		modelId: string;
		temperature: number;
		maxTokens: number;
	} = $props();

	let badgeEl = $state<HTMLSpanElement | undefined>(undefined);
	let badgeFocused = false;

	$effect(() => {
		if (badgeEl && !badgeFocused) {
			badgeEl.textContent = temperature.toFixed(2);
		}
	});

	function onBadgeFocus() {
		badgeFocused = true;
	}

	function onBadgeBlur() {
		badgeFocused = false;
		const val = parseFloat(badgeEl?.textContent ?? '');
		temperature = Number.isNaN(val)
			? temperature
			: Math.max(0, Math.min(currentModel.params.temperatureMax, val));
		if (badgeEl) badgeEl.textContent = temperature.toFixed(2);
	}

	function onBadgeKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			(e.target as HTMLElement).blur();
		}
	}

	let maxTokensBadgeEl = $state<HTMLSpanElement | undefined>(undefined);
	let maxTokensBadgeFocused = false;

	let maxTokensSnaps = $derived.by(() => {
		const max = currentModel.params.maxOutputTokens;
		const snaps: number[] = [1];
		for (let v = 4096; v < max; v += 4096) snaps.push(v);
		if (snaps[snaps.length - 1] !== max) snaps.push(max);
		return snaps;
	});

	let maxTokensSliderIndex = $derived(
		maxTokensSnaps.reduce(
			(best, _, i) =>
				Math.abs(maxTokensSnaps[i] - maxTokens) < Math.abs(maxTokensSnaps[best] - maxTokens)
					? i
					: best,
			0,
		),
	);

	$effect(() => {
		if (maxTokensBadgeEl && !maxTokensBadgeFocused) {
			maxTokensBadgeEl.textContent = String(maxTokens);
		}
	});

	function onMaxTokensBadgeFocus() {
		maxTokensBadgeFocused = true;
	}

	function onMaxTokensBadgeBlur() {
		maxTokensBadgeFocused = false;
		const val = parseInt(maxTokensBadgeEl?.textContent ?? '', 10);
		maxTokens = Number.isNaN(val)
			? maxTokens
			: Math.max(1, Math.min(currentModel.params.maxOutputTokens, val));
		if (maxTokensBadgeEl) maxTokensBadgeEl.textContent = String(maxTokens);
	}

	function onMaxTokensBadgeKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			(e.target as HTMLElement).blur();
		}
	}

	let currentProvider = $derived(PROVIDERS.find((p) => p.id === providerId) ?? PROVIDERS[0]);
	let currentModel = $derived(
		currentProvider.models.find((m) => m.id === modelId) ?? currentProvider.models[0]
	);

	// When provider changes, reset model if the current one isn't in the new provider's list
	$effect(() => {
		const provider = PROVIDERS.find((p) => p.id === providerId);
		if (provider && !provider.models.find((m) => m.id === modelId)) {
			modelId = provider.models[0].id;
		}
	});

	// Clamp temperature and maxTokens to the selected model's limits
	$effect(() => {
		const params = currentModel.params;
		untrack(() => {
			if (maxTokens > params.maxOutputTokens) maxTokens = params.maxOutputTokens;
			if (maxTokens < 1) maxTokens = 1;
			if (temperature > params.temperatureMax) temperature = params.defaultTemperature;
		});
	});
</script>

<aside class="model-config">
	<div class="config-header">
		<h2>Configuration</h2>
	</div>

	<div class="config-body">
		<div class="field">
			<label for="provider">Provider</label>
			<div class="select-wrap">
				<select id="provider" bind:value={providerId}>
					{#each PROVIDERS as provider}
						<option value={provider.id}>{provider.name}</option>
					{/each}
				</select>
				<svg class="select-arrow" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
					<path d="M3 4.5l3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
				</svg>
			</div>
		</div>

		<div class="field">
			<label for="model">Model</label>
			<div class="select-wrap">
				<select id="model" bind:value={modelId}>
					{#each currentProvider.models as model}
						<option value={model.id}>{model.name}</option>
					{/each}
				</select>
				<svg class="select-arrow" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
					<path d="M3 4.5l3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
				</svg>
			</div>
		</div>

		{#if currentModel.params.temperatureMax > 0}
			<div class="field">
				<div class="label-row">
					<label for="temperature">Temperature</label>
					<span
						class="value-badge"
						role="spinbutton"
						tabindex="0"
						contenteditable="true"
						aria-valuenow={temperature}
						aria-valuemin={0}
						aria-valuemax={currentModel.params.temperatureMax}
						bind:this={badgeEl}
						onfocus={onBadgeFocus}
						onblur={onBadgeBlur}
						onkeydown={onBadgeKeydown}
					>{temperature.toFixed(2)}</span
				>
				</div>
				<input
					id="temperature"
					type="range"
					min="0"
					max={currentModel.params.temperatureMax}
					step="0.01"
					bind:value={temperature}
				/>
				<div class="range-hints">
					<span>Precise</span>
					<span>Creative</span>
				</div>
			</div>
		{/if}

		<div class="field">
			<div class="label-row">
				<label for="max-tokens">Max Output Tokens</label>
				<span
					class="value-badge"
					role="spinbutton"
					tabindex="0"
					contenteditable="true"
					aria-valuenow={maxTokens}
					aria-valuemin={1}
					aria-valuemax={currentModel.params.maxOutputTokens}
					bind:this={maxTokensBadgeEl}
					onfocus={onMaxTokensBadgeFocus}
					onblur={onMaxTokensBadgeBlur}
					onkeydown={onMaxTokensBadgeKeydown}
				>{maxTokens}</span>
			</div>
			<input
				id="max-tokens"
				type="range"
				min="0"
				max={maxTokensSnaps.length - 1}
				step="1"
				value={maxTokensSliderIndex}
				oninput={(e) => {
					maxTokens = maxTokensSnaps[+(e.currentTarget as HTMLInputElement).value];
				}}
			/>
		</div>
	</div>

	<div class="model-details">
		<div class="details-header">
			<h2>Model Details</h2>
		</div>
		<div class="details-body">
			<div class="detail-row">
				<span class="detail-label">Max Input Tokens</span>
				<span class="detail-value">{currentModel.params.contextWindow.toLocaleString()}</span>
			</div>
			<div class="detail-row">
				<span class="detail-label">Knowledge Cutoff</span>
				<span class="detail-value">{currentModel.params.knowledgeCutoff}</span>
			</div>
		</div>
	</div>

	<div class="made-by">Made with &lt;3 by @blake__dev + Claude</div>
</aside>

<style>
	.model-config {
		width: 272px;
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		background-color: var(--color-bg);
		border-left: 1px solid var(--color-border);
		overflow-y: auto;
	}

	.model-config::-webkit-scrollbar {
		width: 3px;
	}

	.model-config::-webkit-scrollbar-track {
		background: transparent;
	}

	.model-config::-webkit-scrollbar-thumb {
		background-color: var(--color-border);
		border-radius: 3px;
	}

	.config-header {
		display: flex;
		align-items: center;
		height: 45px;
		padding: 0 16px;
		border-bottom: 1px solid var(--color-border);
		flex-shrink: 0;
	}

	.config-header h2 {
		margin: 0;
		font-size: 0.6875rem;
		font-weight: 600;
		color: var(--color-text);
		text-transform: uppercase;
		letter-spacing: 0.1em;
		line-height: 1;
	}

	.config-body {
		padding: 20px 16px;
		display: flex;
		flex-direction: column;
		gap: 22px;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	label {
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--color-text);
	}

	.label-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.value-badge {
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--color-accent-3, var(--color-accent));
		font-variant-numeric: tabular-nums;
		background-color: color-mix(in srgb, var(--color-accent-3, var(--color-accent)) 12%, transparent);
		padding: 2px 7px;
		border-radius: 4px;
		cursor: text;
		outline: none;
		min-width: 1ch;
	}

	/* Select */
	.select-wrap {
		position: relative;
	}

	select {
		width: 100%;
		padding: 9px 32px 9px 10px;
		appearance: none;
		background-color: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		color: var(--color-text);
		font-family: var(--font-sans);
		font-size: 0.8125rem;
		cursor: pointer;
		box-sizing: border-box;
		transition: border-color 0.15s;
	}

	select:focus {
		outline: none;
		border-color: var(--color-accent-3, var(--color-accent));
	}

	.select-arrow {
		position: absolute;
		right: 10px;
		top: 50%;
		transform: translateY(-50%);
		pointer-events: none;
		color: var(--color-text);
	}

	/* Range slider */
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
		background-color: var(--color-accent-3, var(--color-accent));
		cursor: pointer;
		transition: background-color 0.15s, transform 0.1s;
	}

	input[type='range']::-webkit-slider-thumb:hover {
		background-color: var(--color-accent-3-hover, var(--color-accent-hover));
		transform: scale(1.15);
	}

	input[type='range']::-moz-range-thumb {
		width: 16px;
		height: 16px;
		border: none;
		border-radius: 50%;
		background-color: var(--color-accent-3, var(--color-accent));
		cursor: pointer;
	}

	.range-hints {
		display: flex;
		justify-content: space-between;
		font-size: 0.6875rem;
		color: var(--color-text);
		margin-top: -4px;
	}

	/* Model Details */
	.model-details {
		border-top: 1px solid var(--color-border);
		margin-top: auto;
	}

	.details-header {
		padding: 18px 16px;
		border-bottom: 1px solid var(--color-border);
	}

	.details-header h2 {
		margin: 0;
		font-size: 0.6875rem;
		font-weight: 600;
		color: var(--color-text);
		text-transform: uppercase;
		letter-spacing: 0.1em;
	}

	.details-body {
		padding: 16px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.detail-row {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.detail-label {
		font-size: 0.6875rem;
		font-weight: 500;
		color: var(--color-text);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.detail-value {
		font-size: 0.8125rem;
		color: var(--color-text);
		font-variant-numeric: tabular-nums;
	}

	.made-by {
		padding: 12px 16px;
		font-size: 0.6875rem;
		color: var(--color-text);
		opacity: 0.4;
		text-align: center;
		border-top: 1px solid var(--color-border);
	}
</style>
