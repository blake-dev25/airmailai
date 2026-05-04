<script lang="ts">
    import { untrack } from 'svelte';
    import {
        filterProvidersByTier,
        MODEL_TIERS,
        type ModelOption,
        type ModelTier,
        type ProviderOption,
    } from './constants';

    let {
        providers,
        modelTier,
        providerId = $bindable(),
        modelId = $bindable(),
        temperature = $bindable(),
        maxTokens = $bindable(),
        thinkingLevel = $bindable(),
        adaptiveThinking = $bindable(),
        tokens = null,
    }: {
        providers: ProviderOption[];
        modelTier: ModelTier;
        providerId: string;
        modelId: string;
        temperature: number;
        maxTokens: number;
        thinkingLevel: string;
        adaptiveThinking: boolean;
        tokens?: { input: number; output: number } | null;
    } = $props();

    const TIER_ORDER: ModelTier[] = ['latest', 'previous', 'legacy'];
    const TIER_LABELS: Record<ModelTier, string> = {
        latest: 'Latest',
        previous: 'Previous',
        legacy: 'Legacy',
    };

    function getTier(id: string): ModelTier {
        return MODEL_TIERS[id] ?? 'legacy';
    }

    let filteredProviders = $derived(
        filterProvidersByTier(providers, modelTier),
    );

    let providerOptions = $derived.by(() => {
        // Ensure the chat's stored provider stays visible even if it has no
        // in-tier models — otherwise the select would show a blank value.
        const out = [...filteredProviders];
        if (!out.find((p) => p.id === providerId)) {
            const stored = providers.find((p) => p.id === providerId);
            if (stored) out.push(stored);
        }
        return out;
    });

    // Tier-grouped, sorted options for the model dropdown. If the chat's
    // stored model is out-of-tier, it gets its own group at the top so the
    // select can display it (and the user can revert to it by closing the
    // dropdown without picking).
    let modelGroups = $derived.by(() => {
        const provider =
            providerOptions.find((p) => p.id === providerId) ??
            providerOptions[0];
        if (!provider)
            return [] as Array<{ label: string; models: ModelOption[] }>;

        const inTier = new Set(
            filteredProviders
                .find((p) => p.id === provider.id)
                ?.models.map((m) => m.id) ?? [],
        );

        const groups: Array<{ label: string; models: ModelOption[] }> = [];
        const stored = provider.models.find((m) => m.id === modelId);
        if (stored && !inTier.has(stored.id)) {
            groups.push({ label: 'From this chat', models: [stored] });
        }

        const byTier = new Map<ModelTier, ModelOption[]>();
        for (const m of provider.models) {
            if (!inTier.has(m.id)) continue;
            const tier = getTier(m.id);
            if (!byTier.has(tier)) byTier.set(tier, []);
            byTier.get(tier)!.push(m);
        }
        for (const tier of TIER_ORDER) {
            const models = byTier.get(tier);
            if (models?.length) {
                groups.push({ label: TIER_LABELS[tier], models });
            }
        }
        return groups;
    });

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
            : Math.max(0, Math.min(currentModel.params.temperatureMax!, val));
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
                Math.abs(maxTokensSnaps[i] - maxTokens) <
                Math.abs(maxTokensSnaps[best] - maxTokens)
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

    function abbreviateTokens(n: number): string {
        if (n >= 1_000_000) return `${Math.floor(n / 1_000_000)}M`;
        if (n >= 1_000) return `${Math.floor(n / 1_000)}k`;
        return String(n);
    }

    let currentProvider = $derived(
        providers.find((p) => p.id === providerId) ?? providers[0],
    );
    let currentModel = $derived(
        currentProvider.models.find((m) => m.id === modelId) ??
            currentProvider.models[0],
    );
    let thinkingConfig = $derived(currentModel.params.thinking);
    let thinkingIndex = $derived(
        thinkingConfig
            ? Math.max(0, thinkingConfig.levels.indexOf(thinkingLevel as never))
            : 0,
    );

    function levelLabel(level: string): string {
        if (level === 'medium') return 'Med';
        if (level === 'xhigh') return 'XHigh';
        return level.charAt(0).toUpperCase() + level.slice(1);
    }

    function onProviderChange(e: Event) {
        providerId = (e.currentTarget as HTMLSelectElement).value;
        const filtered = filteredProviders.find((p) => p.id === providerId);
        const fallback = providers.find((p) => p.id === providerId);
        const first = filtered?.models[0] ?? fallback?.models[0];
        if (first) {
            modelId = first.id;
            maxTokens = first.params.defaultMaxTokens;
            if (first.params.defaultTemperature !== undefined)
                temperature = first.params.defaultTemperature;
            thinkingLevel = first.params.thinking?.defaultLevel ?? 'none';
            adaptiveThinking = first.params.thinking?.adaptive !== undefined;
        }
    }

    function onModelChange(e: Event) {
        modelId = (e.currentTarget as HTMLSelectElement).value;
        const model = currentProvider.models.find((m) => m.id === modelId);
        if (model) {
            maxTokens = model.params.defaultMaxTokens;
            if (model.params.defaultTemperature !== undefined)
                temperature = model.params.defaultTemperature;
            thinkingLevel = model.params.thinking?.defaultLevel ?? 'none';
            adaptiveThinking = model.params.thinking?.adaptive !== undefined;
        }
    }

    // Airmail stripe — same geometry as Sidebar, adapted for modelConfig width
    const mcStripeH = 20;
    const mcStripeW = 40;
    const mcGap = 40;
    const mcPitch = mcStripeW + mcGap;
    const mcW = 272;
    const mcStartI = -Math.ceil(mcStripeH / mcPitch) - 1;
    const mcEndI = Math.ceil(mcW / mcPitch) + 1;
    const mcStripes = Array.from(
        { length: mcEndI - mcStartI + 1 },
        (_, idx) => {
            const i = mcStartI + idx;
            const x = i * mcPitch - 8;
            return {
                points: `${x + mcStripeH},0 ${x + mcStripeH + mcStripeW},0 ${x + mcStripeW},${mcStripeH} ${x},${mcStripeH}`,
                red: i % 2 === 0,
            };
        },
    );

    // Safety clamp for externally set values (e.g. loading a chat saved with an old model limit)
    $effect(() => {
        const params = currentModel.params;
        untrack(() => {
            if (maxTokens > params.maxOutputTokens)
                maxTokens = params.maxOutputTokens;
            if (maxTokens < 1) maxTokens = 1;
            if (
                params.temperatureMax !== undefined &&
                temperature > params.temperatureMax
            )
                temperature = params.defaultTemperature ?? 1;
            // If the loaded thinkingLevel isn't valid for this model, fall back to default
            if (
                params.thinking &&
                !params.thinking.levels.includes(thinkingLevel as never)
            ) {
                thinkingLevel = params.thinking.defaultLevel;
            }
            if (!params.thinking) thinkingLevel = 'none';
            // Coerce adaptiveThinking to a valid state for the current model
            const adaptiveSupport = params.thinking?.adaptive;
            if (adaptiveSupport === 'required') adaptiveThinking = true;
            else if (adaptiveSupport === undefined) adaptiveThinking = false;
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
                <select
                    id="provider"
                    value={providerId}
                    onchange={onProviderChange}
                >
                    {#each providerOptions as provider}
                        <option value={provider.id}>{provider.name}</option>
                    {/each}
                </select>
                <svg
                    class="select-arrow"
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="none"
                    aria-hidden="true"
                >
                    <path
                        d="M3 4.5l3 3 3-3"
                        stroke="currentColor"
                        stroke-width="1.5"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                    />
                </svg>
            </div>
        </div>

        <div class="field">
            <label for="model">Model</label>
            <div class="select-wrap">
                <select id="model" value={modelId} onchange={onModelChange}>
                    {#if modelGroups.length === 1}
                        {#each modelGroups[0].models as model}
                            <option value={model.id}>{model.name}</option>
                        {/each}
                    {:else}
                        {#each modelGroups as group}
                            <optgroup label={group.label}>
                                {#each group.models as model}
                                    <option value={model.id}
                                        >{model.name}</option
                                    >
                                {/each}
                            </optgroup>
                        {/each}
                    {/if}
                </select>
                <svg
                    class="select-arrow"
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="none"
                    aria-hidden="true"
                >
                    <path
                        d="M3 4.5l3 3 3-3"
                        stroke="currentColor"
                        stroke-width="1.5"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                    />
                </svg>
            </div>
        </div>

        {#if currentModel.params.temperatureMax !== undefined}
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

        {#if thinkingConfig}
            <div class="field">
                <div class="label-row">
                    <label for="thinking">Thinking</label>
                    <span class="value-badge">{levelLabel(thinkingLevel)}</span>
                </div>
                <input
                    id="thinking"
                    type="range"
                    min="0"
                    max={thinkingConfig.levels.length - 1}
                    step="1"
                    value={thinkingIndex}
                    oninput={(e) => {
                        thinkingLevel =
                            thinkingConfig!.levels[
                                +(e.currentTarget as HTMLInputElement).value
                            ];
                    }}
                />
                <div class="range-hints">
                    <span>None</span>
                    <span
                        >{levelLabel(
                            thinkingConfig.levels[
                                thinkingConfig.levels.length - 1
                            ],
                        )}</span
                    >
                </div>
            </div>
        {/if}

        {#if thinkingConfig?.adaptive && thinkingLevel !== 'none'}
            {@const locked = thinkingConfig.adaptive === 'required'}
            <div class="field">
                <div class="label-row">
                    <label for="adaptive-thinking">Adaptive Thinking</label>
                    <button
                        id="adaptive-thinking"
                        type="button"
                        class="ios-switch"
                        class:on={adaptiveThinking}
                        class:locked
                        role="switch"
                        aria-checked={adaptiveThinking}
                        aria-label="Adaptive Thinking"
                        disabled={locked}
                        title={locked
                            ? 'This model only supports adaptive thinking.'
                            : undefined}
                        onclick={() => {
                            if (!locked) adaptiveThinking = !adaptiveThinking;
                        }}
                    >
                        <span class="ios-switch-thumb"></span>
                    </button>
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
                    onkeydown={onMaxTokensBadgeKeydown}>{maxTokens}</span
                >
            </div>
            <input
                id="max-tokens"
                type="range"
                min="0"
                max={maxTokensSnaps.length - 1}
                step="1"
                value={maxTokensSliderIndex}
                oninput={(e) => {
                    maxTokens =
                        maxTokensSnaps[
                            +(e.currentTarget as HTMLInputElement).value
                        ];
                }}
            />
            <div class="range-hints">
                <span>1</span>
                <span
                    >{abbreviateTokens(
                        currentModel.params.maxOutputTokens,
                    )}</span
                >
            </div>
        </div>
    </div>

    <div class="model-details">
        <div class="details-header">
            <h2>Model Details</h2>
        </div>
        <div class="details-body">
            <div class="detail-row">
                <span class="detail-label">Context Window</span>
                <span class="detail-value">
                    {#if tokens}
                        {(tokens.input + tokens.output).toLocaleString()} / {currentModel.params.contextWindow.toLocaleString()}
                    {:else}
                        {currentModel.params.contextWindow.toLocaleString()}
                    {/if}
                </span>
            </div>
            {#if currentModel.params.knowledgeCutoff}
                <div class="detail-row">
                    <span class="detail-label">Knowledge Cutoff</span>
                    <span class="detail-value"
                        >{currentModel.params.knowledgeCutoff}</span
                    >
                </div>
            {/if}
        </div>
    </div>

    <div class="made-by">Made with &lt;3 by @blake__dev + AI</div>

    <svg
        width={mcW}
        height={mcStripeH}
        viewBox="0 0 {mcW} {mcStripeH}"
        class="airmail-stripe"
        aria-hidden="true"
    >
        <defs>
            <clipPath id="mc-stripe-clip">
                <rect width={mcW} height={mcStripeH} />
            </clipPath>
        </defs>
        <g clip-path="url(#mc-stripe-clip)">
            <rect width={mcW} height={mcStripeH} fill="var(--color-bg)" />
            {#each mcStripes as stripe}
                <polygon
                    points={stripe.points}
                    fill={stripe.red
                        ? 'var(--color-accent)'
                        : 'var(--color-accent-2)'}
                />
            {/each}
        </g>
    </svg>
</aside>

<style>
    .model-config {
        width: 272px;
        flex-shrink: 0;
        display: flex;
        flex-direction: column;
        background-color: var(--color-bg);
        border-left: 1px solid var(--color-border);
        overflow-x: hidden;
        overflow-y: auto;
        -webkit-user-select: none;
        user-select: none;
    }

    .model-config input,
    .model-config [contenteditable='true'] {
        -webkit-user-select: text;
        user-select: text;
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
        font-size: 0.8125rem;
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
        background-color: color-mix(
            in srgb,
            var(--color-accent-3, var(--color-accent)) 12%,
            transparent
        );
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
        transition:
            background-color 0.15s,
            transform 0.1s;
    }

    input[type='range']::-webkit-slider-thumb:hover {
        background-color: var(
            --color-accent-3-hover,
            var(--color-accent-hover)
        );
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

    /* iOS-style switch */
    .ios-switch {
        position: relative;
        width: 34px;
        height: 20px;
        padding: 0;
        background-color: var(--color-surface-raised);
        border: 1px solid var(--color-border);
        border-radius: 999px;
        cursor: pointer;
        transition:
            background-color 0.18s ease,
            border-color 0.18s ease;
        flex-shrink: 0;
    }

    .ios-switch.on {
        background-color: var(--color-accent-3, var(--color-accent));
        border-color: var(--color-accent-3, var(--color-accent));
    }

    .ios-switch-thumb {
        position: absolute;
        top: 1px;
        left: 1px;
        width: 16px;
        height: 16px;
        background-color: var(--color-bg);
        border-radius: 50%;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
        transition: transform 0.18s ease;
    }

    .ios-switch.on .ios-switch-thumb {
        transform: translateX(14px);
    }

    .ios-switch.locked {
        cursor: not-allowed;
        opacity: 0.6;
    }

    /* Model Details */
    .model-details {
        border-top: 1px solid var(--color-border);
        margin-top: auto;
    }

    .details-header {
        padding: 18px 16px 0px;
    }

    .details-header h2 {
        margin: 0;
        font-size: 0.8125rem;
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
        font-size: 0.75rem;
        color: var(--color-text);
        text-transform: uppercase;
        letter-spacing: 0.05em;
    }

    .detail-value {
        font-size: 0.75rem;
        color: var(--color-text);
        font-variant-numeric: tabular-nums;
    }

    .made-by {
        padding: 8px 0px;
        font-size: 12px;
        color: var(--color-text);
        opacity: 0.4;
        text-align: center;
        border-top: 1px solid var(--color-border);
    }

    .airmail-stripe {
        display: block;
        flex-shrink: 0;
    }
</style>
