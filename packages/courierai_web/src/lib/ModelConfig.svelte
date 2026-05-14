<script lang="ts">
    import { untrack } from 'svelte';
    import {
        filterProvidersByTier,
        MODEL_TIERS,
        type ModelOption,
        type ModelTier,
        type ProviderOption,
    } from './constants';
    import Icon from './Icon.svelte';
    import ModelPicker from './ModelPicker.svelte';

    let {
        providers,
        modelTier,
        initialized,
        providerId = $bindable(),
        modelId = $bindable(),
        temperature = $bindable(),
        maxTokens = $bindable(),
        thinkingLevel = $bindable(),
        adaptiveThinking = $bindable(),
        webSearch = $bindable(),
        enableWebSearch,
        tokens = null,
    }: {
        providers: ProviderOption[];
        modelTier: ModelTier;
        initialized: boolean;
        providerId: string;
        modelId: string;
        temperature: number;
        maxTokens: number;
        thinkingLevel: string;
        adaptiveThinking: boolean;
        webSearch: boolean;
        enableWebSearch: boolean;
        tokens?: { input: number; output: number } | null;
    } = $props();

    const TIER_ORDER: ModelTier[] = ['latest', 'previous', 'legacy'];
    const TIER_LABELS: Record<ModelTier, string> = {
        latest: 'Latest',
        previous: 'Previous',
        legacy: 'Legacy',
    };
    const OPENROUTER_EMPTY_LABEL =
        'Please load an OpenRouter API key to download their model catalog.';

    function getTier(id: string): ModelTier {
        return MODEL_TIERS[id] ?? 'legacy';
    }

    let filteredProviders = $derived(
        filterProvidersByTier(providers, modelTier)
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

    // Marketplace providers (OpenRouter) skip tier curation. Their catalog is
    // pre-sorted by the parent (vendor-pinned, then newest-first), and we
    // group by vendor here so users can scan by upstream maker.
    let modelGroups = $derived.by(() => {
        const provider =
            providerOptions.find((p) => p.id === providerId) ??
            providerOptions[0];
        if (!provider)
            return [] as Array<{ label: string; models: ModelOption[] }>;

        if (provider.marketplace) {
            // `~`-prefix is OpenRouter's premier-provider tag — a curated
            // subset (e.g. latest models) that lives as its own group, distinct
            // from the same vendor's non-premier catalog.
            const formatVendor = (v: string) =>
                v.startsWith('~') ? `★ ${v.slice(1)}` : v;
            const groups: Array<{ label: string; models: ModelOption[] }> = [];
            let currentVendor: string | null = null;
            let bucket: ModelOption[] = [];
            for (const m of provider.models) {
                const v = m.vendor ?? 'other';
                if (v !== currentVendor) {
                    if (bucket.length)
                        groups.push({
                            label: formatVendor(currentVendor!),
                            models: bucket,
                        });
                    currentVendor = v;
                    bucket = [];
                }
                bucket.push(m);
            }
            if (bucket.length)
                groups.push({
                    label: formatVendor(currentVendor!),
                    models: bucket,
                });
            return groups;
        }

        // Tier-grouped, sorted options for first-party providers. If the
        // chat's stored model is out-of-tier, it gets its own group at the top
        // so the picker can display it (and the user can revert to it by
        // closing without picking).
        const inTier = new Set(
            filteredProviders
                .find((p) => p.id === provider.id)
                ?.models.map((m) => m.id) ?? []
        );

        const groups: Array<{ label: string; models: ModelOption[] }> = [];
        const stored = providers
            .find((p) => p.id === provider.id)
            ?.models.find((m) => m.id === modelId);
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
            // contenteditable badge — Svelte yields ownership while editing.
            // eslint-disable-next-line svelte/no-dom-manipulating
            badgeEl.textContent = temperature.toFixed(2);
        }
    });

    function onBadgeFocus() {
        badgeFocused = true;
    }

    function onBadgeBlur() {
        badgeFocused = false;
        if (!currentModel) return;
        const val = parseFloat(badgeEl?.textContent ?? '');
        temperature = Number.isNaN(val)
            ? temperature
            : Math.max(0, Math.min(currentModel.params.temperatureMax!, val));
        // eslint-disable-next-line svelte/no-dom-manipulating
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
        const max = currentModel?.params.maxOutputTokens ?? 8192;
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
            0
        )
    );

    $effect(() => {
        if (maxTokensBadgeEl && !maxTokensBadgeFocused) {
            // eslint-disable-next-line svelte/no-dom-manipulating
            maxTokensBadgeEl.textContent = String(maxTokens);
        }
    });

    function onMaxTokensBadgeFocus() {
        maxTokensBadgeFocused = true;
    }

    function onMaxTokensBadgeBlur() {
        maxTokensBadgeFocused = false;
        if (!currentModel) return;
        const val = parseInt(maxTokensBadgeEl?.textContent ?? '', 10);
        maxTokens = Number.isNaN(val)
            ? maxTokens
            : Math.max(1, Math.min(currentModel.params.maxOutputTokens, val));
        // eslint-disable-next-line svelte/no-dom-manipulating
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
        providers.find((p) => p.id === providerId) ?? providers[0]
    );
    let currentModel = $derived<ModelOption | undefined>(
        currentProvider.models.find((m) => m.id === modelId) ??
            currentProvider.models[0]
    );
    let thinkingConfig = $derived(currentModel?.params.thinking);
    let thinkingIndex = $derived(
        thinkingConfig
            ? Math.max(0, thinkingConfig.levels.indexOf(thinkingLevel as never))
            : 0
    );
    let modelPickerEmptyLabel = $derived(
        currentProvider.id === 'openrouter'
            ? OPENROUTER_EMPTY_LABEL
            : 'Loading models...'
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
            webSearch = false;
        }
    }

    function onModelChange(id: string) {
        const model = currentProvider.models.find((m) => m.id === id);
        if (model) {
            maxTokens = model.params.defaultMaxTokens;
            if (model.params.defaultTemperature !== undefined)
                temperature = model.params.defaultTemperature;
            thinkingLevel = model.params.thinking?.defaultLevel ?? 'none';
            adaptiveThinking = model.params.thinking?.adaptive !== undefined;
            webSearch = false;
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
        }
    );

    // Safety clamp for externally set values (e.g. loading a chat saved with an old model limit)
    $effect(() => {
        if (!currentModel) return;
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

    const labelClass = 'text-sm font-medium text-fg';
    const fieldClass = 'flex flex-col gap-2';
    const labelRowClass = 'flex items-center justify-between';
    const valueBadgeClass =
        'text-xs font-semibold text-accent-3-fg [font-variant-numeric:tabular-nums] bg-[color-mix(in_srgb,var(--color-accent-3-bg)_12%,transparent)] px-[7px] py-0.5 rounded cursor-text outline-none min-w-[1ch]';
    const selectClass =
        'w-full pl-2.5 pr-8 py-[9px] appearance-none bg-canvas border border-border rounded-lg text-fg font-sans text-sm cursor-pointer box-border transition-[border-color] duration-150 focus:outline-none focus:border-accent-3-fg';
    const rangeClass =
        'range-styled appearance-none w-full h-1 bg-surface-raised border-0 rounded p-0 cursor-pointer outline-none';
    const rangeHintsClass =
        'flex justify-between text-[0.6875rem] text-fg -mt-1';
    const detailRowClass = 'flex flex-col gap-[3px]';
    const detailLabelClass = 'text-xs text-fg uppercase tracking-wider';
    const detailValueClass =
        'text-xs text-fg [font-variant-numeric:tabular-nums]';
</script>

<aside
    class="model-config thin-scrollbar shrink-0 flex w-68 flex-col bg-canvas border-l border-border overflow-x-hidden overflow-y-auto select-none [&_input]:select-text **:[[contenteditable=true]]:select-text"
>
    <div class="flex shrink-0 items-center h-11.25 px-4 border-b border-border">
        <h2
            class="m-0 text-sm font-semibold text-fg uppercase tracking-widest leading-none"
        >
            Configuration
        </h2>
    </div>

    <div class="px-4 py-5 flex flex-col gap-5.5">
        <div class={fieldClass}>
            <label for="provider" class={labelClass}>Provider</label>
            <div class="relative">
                <select
                    id="provider"
                    class={selectClass}
                    value={providerId}
                    onchange={onProviderChange}
                >
                    {#if initialized}
                        {#each providerOptions as provider (provider.id)}
                            <option value={provider.id}>{provider.name}</option>
                        {/each}
                    {/if}
                </select>
                <Icon name="chevron-down" size={12} class="select-arrow" />
            </div>
        </div>

        <div class={fieldClass}>
            <label for="model" class={labelClass}>Model</label>
            <ModelPicker
                groups={modelGroups}
                bind:value={modelId}
                onchange={onModelChange}
                disabled={!initialized}
                emptyLabel={modelPickerEmptyLabel}
            />
        </div>

        {#if initialized && currentModel}
            {#if currentModel.params.temperatureMax !== undefined}
                <div class={fieldClass}>
                    <div class={labelRowClass}>
                        <label for="temperature" class={labelClass}
                            >Temperature</label
                        >
                        <span
                            class={valueBadgeClass}
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
                        class={rangeClass}
                        min="0"
                        max={currentModel.params.temperatureMax}
                        step="0.01"
                        bind:value={temperature}
                    />
                    <div class={rangeHintsClass}>
                        <span>Precise</span>
                        <span>Creative</span>
                    </div>
                </div>
            {/if}

            {#if thinkingConfig}
                <div class={fieldClass}>
                    <div class={labelRowClass}>
                        <label for="thinking" class={labelClass}>Thinking</label
                        >
                        <span class={valueBadgeClass}
                            >{levelLabel(thinkingLevel)}</span
                        >
                    </div>
                    <input
                        id="thinking"
                        type="range"
                        class={rangeClass}
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
                    <div class={rangeHintsClass}>
                        <span>None</span>
                        <span
                            >{levelLabel(
                                thinkingConfig.levels[
                                    thinkingConfig.levels.length - 1
                                ]
                            )}</span
                        >
                    </div>
                </div>
            {/if}

            {#if thinkingConfig?.adaptive && thinkingLevel !== 'none'}
                {@const locked = thinkingConfig.adaptive === 'required'}
                <div class={fieldClass}>
                    <div class={labelRowClass}>
                        <label for="adaptive-thinking" class={labelClass}
                            >Adaptive Thinking</label
                        >
                        <button
                            id="adaptive-thinking"
                            type="button"
                            class={[
                                'ios-switch shrink-0 relative w-8.5 h-5 p-0 rounded-full cursor-pointer transition-[background-color,border-color] duration-200',
                                locked && 'cursor-not-allowed opacity-60',
                            ]}
                            class:on={adaptiveThinking}
                            role="switch"
                            aria-checked={adaptiveThinking}
                            aria-label="Adaptive Thinking"
                            disabled={locked}
                            title={locked
                                ? 'This model only supports adaptive thinking.'
                                : undefined}
                            onclick={() => {
                                if (!locked)
                                    adaptiveThinking = !adaptiveThinking;
                            }}
                        >
                            <span class="ios-switch-thumb"></span>
                        </button>
                    </div>
                </div>
            {/if}

            <div class={fieldClass}>
                <div class={labelRowClass}>
                    <label for="max-tokens" class={labelClass}
                        >Max Output Tokens</label
                    >
                    <span
                        class={valueBadgeClass}
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
                    class={rangeClass}
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
                <div class={rangeHintsClass}>
                    <span>1</span>
                    <span
                        >{abbreviateTokens(
                            currentModel.params.maxOutputTokens
                        )}</span
                    >
                </div>
            </div>

            {#if enableWebSearch}
                <div class={fieldClass}>
                    <div class={labelRowClass}>
                        <label for="web-search" class={labelClass}
                            >Web Search</label
                        >
                        <button
                            id="web-search"
                            type="button"
                            class={[
                                'ios-switch shrink-0 relative w-8.5 h-5 p-0 rounded-full cursor-pointer transition-[background-color,border-color] duration-200',
                            ]}
                            class:on={webSearch}
                            role="switch"
                            aria-checked={webSearch}
                            aria-label="Web Search"
                            onclick={() => {
                                webSearch = !webSearch;
                            }}
                        >
                            <span class="ios-switch-thumb"></span>
                        </button>
                    </div>
                </div>
            {/if}
        {/if}
    </div>

    <div class="border-t border-border mt-auto">
        <div class="pt-4.5 px-4">
            <h2
                class="m-0 text-sm font-semibold text-fg uppercase tracking-widest"
            >
                Model Details
            </h2>
        </div>
        <div class="p-4 flex flex-col gap-3">
            <div class={detailRowClass}>
                <span class={detailLabelClass}>Context Window</span>
                <span class={detailValueClass}>
                    {#if !initialized || !currentModel}
                        &nbsp;
                    {:else if tokens}
                        {(tokens.input + tokens.output).toLocaleString()} / {currentModel.params.contextWindow.toLocaleString()}
                    {:else}
                        {currentModel.params.contextWindow.toLocaleString()}
                    {/if}
                </span>
            </div>
            {#if !initialized || !currentModel || currentModel.params.knowledgeCutoff}
                <div class={detailRowClass}>
                    <span class={detailLabelClass}>Knowledge Cutoff</span>
                    <span class={detailValueClass}
                        >{initialized && currentModel
                            ? currentModel.params.knowledgeCutoff
                            : ' '}</span
                    >
                </div>
            {/if}
        </div>
    </div>

    <div
        class="py-2 text-[12px] text-fg opacity-40 text-center border-t border-border"
    >
        Made with &lt;3 by <a
            href="https://x.com/blake__dev"
            target="_blank"
            rel="noopener noreferrer"
            class="text-inherit no-underline hover:underline">@blake__dev</a
        > + AI
    </div>

    <svg
        width={mcW}
        height={mcStripeH}
        viewBox="0 0 {mcW} {mcStripeH}"
        class="block shrink-0"
        aria-hidden="true"
    >
        <defs>
            <clipPath id="mc-stripe-clip">
                <rect width={mcW} height={mcStripeH} />
            </clipPath>
        </defs>
        <g clip-path="url(#mc-stripe-clip)">
            <rect width={mcW} height={mcStripeH} fill="var(--color-canvas)" />
            <!-- eslint-disable-next-line svelte/require-each-key -->
            {#each mcStripes as stripe}
                <polygon
                    points={stripe.points}
                    fill={stripe.red
                        ? 'var(--color-accent-bg)'
                        : 'var(--color-accent-2-bg)'}
                />
            {/each}
        </g>
    </svg>
</aside>

<style>
    /* CSS islands — pseudo-element-heavy patterns */

    /* Custom scrollbar for the panel */
    .thin-scrollbar::-webkit-scrollbar {
        width: 3px;
    }
    .thin-scrollbar::-webkit-scrollbar-track {
        background: transparent;
    }
    .thin-scrollbar::-webkit-scrollbar-thumb {
        background-color: var(--color-border);
        border-radius: 3px;
    }

    /* Range slider thumb (uses accent-3 — the "action" highlight) */
    .range-styled::-webkit-slider-thumb {
        -webkit-appearance: none;
        appearance: none;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background-color: var(--color-accent-3-bg);
        cursor: pointer;
        transition:
            background-color 0.15s,
            transform 0.1s;
    }

    .range-styled::-webkit-slider-thumb:hover {
        background-color: var(--color-accent-3-bg-hover);
        transform: scale(1.15);
    }

    .range-styled::-moz-range-thumb {
        width: 16px;
        height: 16px;
        border: none;
        border-radius: 50%;
        background-color: var(--color-accent-3-bg);
        cursor: pointer;
    }

    /* iOS-style switch — base + on state + thumb. Pseudo-element-free but
     * the on-state styling and thumb slide are simpler to express here than
     * across the markup's class array. */
    .ios-switch {
        background-color: var(--color-surface-raised);
        border: 1px solid var(--color-border);
    }

    .ios-switch.on {
        background-color: var(--color-accent-3-bg);
        border-color: var(--color-accent-3-bg);
    }

    .ios-switch-thumb {
        position: absolute;
        top: 1px;
        left: 1px;
        width: 16px;
        height: 16px;
        background-color: var(--color-canvas);
        border-radius: 50%;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
        transition: transform 0.18s ease;
    }

    .ios-switch.on .ios-switch-thumb {
        transform: translateX(14px);
    }

    /* The chevron icon overlaid on selects — passed to Icon component */
    :global(.select-arrow) {
        position: absolute;
        right: 10px;
        top: 50%;
        transform: translateY(-50%);
        pointer-events: none;
        color: var(--color-fg);
    }
</style>
