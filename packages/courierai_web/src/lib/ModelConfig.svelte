<script lang="ts">
    import { untrack } from 'svelte';
    import { appLifecycle } from './appLifecycle.svelte';
    import { chatStore } from './chatStore.svelte';
    import {
        defaultModelForProvider,
        filterProvidersByTier,
        MODEL_TIERS,
        type ModelOption,
        type ModelTier,
    } from './constants';
    import Icon from './Icon.svelte';
    import ModelPicker, { type ModelGroup } from './ModelPicker.svelte';
    import { providersStore } from './providersStore.svelte';
    import { settingsStore } from './settingsStore.svelte';

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
        filterProvidersByTier(providersStore.providers, settingsStore.modelTier)
    );

    let providerOptions = $derived.by(() => {
        const out = [...filteredProviders];
        if (!out.find((p) => p.id === settingsStore.providerId)) {
            const stored = providersStore.providers.find(
                (p) => p.id === settingsStore.providerId
            );
            if (stored) out.push(stored);
        }
        return out;
    });

    let modelGroups = $derived.by(() => {
        const provider =
            providerOptions.find((p) => p.id === settingsStore.providerId) ??
            providerOptions[0];
        if (!provider) return [] as ModelGroup[];

        if (provider.marketplace) {
            // *** `~`-prefix is OpenRouter's premier-provider tag - a curated
            // subset (e.g. latest models) that lives as its own group, distinct
            // from the same vendor's non-premier catalog.
            const groups: ModelGroup[] = [];
            const pushBucket = (vendor: string, models: ModelOption[]) => {
                const pinned = vendor.startsWith('~');
                groups.push({
                    label: pinned ? vendor.slice(1) : vendor,
                    pinned,
                    models,
                });
            };
            let currentVendor: string | null = null;
            let bucket: ModelOption[] = [];
            for (const m of provider.models) {
                const v = m.vendor ?? 'other';
                if (v !== currentVendor) {
                    if (bucket.length) pushBucket(currentVendor!, bucket);
                    currentVendor = v;
                    bucket = [];
                }
                bucket.push(m);
            }
            if (bucket.length) pushBucket(currentVendor!, bucket);
            return groups;
        }

        const inTier = new Set(
            filteredProviders
                .find((p) => p.id === provider.id)
                ?.models.map((m) => m.id) ?? []
        );

        const groups: ModelGroup[] = [];
        const stored = providersStore.providers
            .find((p) => p.id === provider.id)
            ?.models.find((m) => m.id === settingsStore.modelId);
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
            // eslint-disable-next-line svelte/no-dom-manipulating
            badgeEl.textContent = settingsStore.temperature.toFixed(2);
        }
    });

    function onBadgeFocus() {
        badgeFocused = true;
    }

    function onBadgeBlur() {
        badgeFocused = false;
        if (!currentModel) return;
        const val = parseFloat(badgeEl?.textContent ?? '');
        settingsStore.temperature = Number.isNaN(val)
            ? settingsStore.temperature
            : Math.max(0, Math.min(currentModel.params.temperatureMax!, val));
        if (badgeEl)
            // eslint-disable-next-line svelte/no-dom-manipulating
            badgeEl.textContent = settingsStore.temperature.toFixed(2);
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
                Math.abs(maxTokensSnaps[i] - settingsStore.maxTokens) <
                Math.abs(maxTokensSnaps[best] - settingsStore.maxTokens)
                    ? i
                    : best,
            0
        )
    );

    $effect(() => {
        if (maxTokensBadgeEl && !maxTokensBadgeFocused) {
            // eslint-disable-next-line svelte/no-dom-manipulating
            maxTokensBadgeEl.textContent = String(settingsStore.maxTokens);
        }
    });

    function onMaxTokensBadgeFocus() {
        maxTokensBadgeFocused = true;
    }

    function onMaxTokensBadgeBlur() {
        maxTokensBadgeFocused = false;
        if (!currentModel) return;
        const val = parseInt(maxTokensBadgeEl?.textContent ?? '', 10);
        settingsStore.maxTokens = Number.isNaN(val)
            ? settingsStore.maxTokens
            : Math.max(1, Math.min(currentModel.params.maxOutputTokens, val));
        if (maxTokensBadgeEl)
            // eslint-disable-next-line svelte/no-dom-manipulating
            maxTokensBadgeEl.textContent = String(settingsStore.maxTokens);
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
        providersStore.providers.find(
            (p) => p.id === settingsStore.providerId
        ) ?? providersStore.providers[0]
    );
    let currentModel = $derived<ModelOption | undefined>(
        currentProvider.models.find((m) => m.id === settingsStore.modelId) ??
            currentProvider.models[0]
    );
    let thinkingConfig = $derived(currentModel?.params.thinking);
    let thinkingIndex = $derived(
        thinkingConfig
            ? Math.max(
                  0,
                  (thinkingConfig.levels as readonly string[]).indexOf(
                      settingsStore.thinkingLevel
                  )
              )
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
        settingsStore.providerId = (e.currentTarget as HTMLSelectElement).value;
        const filtered = filteredProviders.find(
            (p) => p.id === settingsStore.providerId
        );
        const fallback = providersStore.providers.find(
            (p) => p.id === settingsStore.providerId
        );
        const source = filtered ?? fallback;
        const first = source ? defaultModelForProvider(source) : undefined;
        if (first) {
            settingsStore.modelId = first.id;
            settingsStore.maxTokens = first.params.defaultMaxTokens;
            if (first.params.defaultTemperature !== undefined)
                settingsStore.temperature = first.params.defaultTemperature;
            settingsStore.thinkingLevel =
                first.params.thinking?.defaultLevel ?? 'none';
            settingsStore.adaptiveThinking =
                first.params.thinking?.adaptive !== undefined;
            settingsStore.applyToolDefaults(first);
        }
    }

    function onModelChange(id: string) {
        const model = currentProvider.models.find((m) => m.id === id);
        if (model) {
            settingsStore.maxTokens = model.params.defaultMaxTokens;
            if (model.params.defaultTemperature !== undefined)
                settingsStore.temperature = model.params.defaultTemperature;
            settingsStore.thinkingLevel =
                model.params.thinking?.defaultLevel ?? 'none';
            settingsStore.adaptiveThinking =
                model.params.thinking?.adaptive !== undefined;
            settingsStore.applyToolDefaults(model);
        }
    }

    let modelTools = $derived(currentModel?.tools);
    let webSearchSupported = $derived(!!modelTools?.webSearch);
    let webFetchSupported = $derived(!!modelTools?.webFetch);
    let codeExecSupported = $derived(!!modelTools?.codeExecution);
    let searchFetchLinked = $derived(!!modelTools?.searchFetchLinked);
    let showLinkedWeb = $derived(
        searchFetchLinked &&
            webSearchSupported &&
            webFetchSupported &&
            settingsStore.enableWebSearch &&
            settingsStore.enableWebFetch
    );
    let showWebSearch = $derived(
        !showLinkedWeb && webSearchSupported && settingsStore.enableWebSearch
    );
    let showWebFetch = $derived(
        !showLinkedWeb && webFetchSupported && settingsStore.enableWebFetch
    );
    let showCodeExec = $derived(
        codeExecSupported && settingsStore.enableCodeExecution
    );
    let linkedWebOn = $derived(
        settingsStore.webSearch && settingsStore.webFetch
    );
    function toggleLinkedWeb() {
        const next = !linkedWebOn;
        settingsStore.webSearch = next;
        settingsStore.webFetch = next;
    }

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

    $effect(() => {
        if (!currentModel) return;
        const params = currentModel.params;
        const tools = currentModel.tools;
        untrack(() => {
            if (settingsStore.maxTokens > params.maxOutputTokens)
                settingsStore.maxTokens = params.maxOutputTokens;
            if (settingsStore.maxTokens < 1) settingsStore.maxTokens = 1;
            if (
                params.temperatureMax !== undefined &&
                settingsStore.temperature > params.temperatureMax
            )
                settingsStore.temperature = params.defaultTemperature ?? 1;
            if (
                params.thinking &&
                !(params.thinking.levels as readonly string[]).includes(
                    settingsStore.thinkingLevel
                )
            ) {
                settingsStore.thinkingLevel = params.thinking.defaultLevel;
            }
            if (!params.thinking) settingsStore.thinkingLevel = 'none';
            const adaptiveSupport = params.thinking?.adaptive;
            if (adaptiveSupport === 'required')
                settingsStore.adaptiveThinking = true;
            else if (adaptiveSupport === undefined)
                settingsStore.adaptiveThinking = false;
            if (settingsStore.webSearch && !tools?.webSearch)
                settingsStore.webSearch = false;
            if (settingsStore.webFetch && !tools?.webFetch)
                settingsStore.webFetch = false;
            if (settingsStore.codeExecution && !tools?.codeExecution)
                settingsStore.codeExecution = false;
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
    const detailLabelClass = 'text-xs text-fg-muted';
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
                    value={settingsStore.providerId}
                    onchange={onProviderChange}
                >
                    {#if appLifecycle.initialized}
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
                bind:value={settingsStore.modelId}
                onchange={onModelChange}
                disabled={!appLifecycle.initialized}
                emptyLabel={modelPickerEmptyLabel}
            />
        </div>

        {#if appLifecycle.initialized && currentModel}
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
                            aria-label="Temperature"
                            aria-valuenow={settingsStore.temperature}
                            aria-valuemin={0}
                            aria-valuemax={currentModel.params.temperatureMax}
                            bind:this={badgeEl}
                            onfocus={onBadgeFocus}
                            onblur={onBadgeBlur}
                            onkeydown={onBadgeKeydown}
                            >{settingsStore.temperature.toFixed(2)}</span
                        >
                    </div>
                    <input
                        id="temperature"
                        type="range"
                        class={rangeClass}
                        min="0"
                        max={currentModel.params.temperatureMax}
                        step="0.01"
                        bind:value={settingsStore.temperature}
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
                            >{levelLabel(settingsStore.thinkingLevel)}</span
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
                            settingsStore.thinkingLevel =
                                thinkingConfig!.levels[
                                    +(e.currentTarget as HTMLInputElement).value
                                ];
                        }}
                    />
                    <div class={rangeHintsClass}>
                        <span>{levelLabel(thinkingConfig.levels[0])}</span>
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

            {#if thinkingConfig?.adaptive && settingsStore.thinkingLevel !== 'none'}
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
                                'toggle-switch shrink-0 relative w-8.5 h-5 p-0 rounded-full cursor-pointer transition-[background-color,border-color] duration-200',
                                locked && 'cursor-not-allowed opacity-60',
                                settingsStore.adaptiveThinking && 'on',
                            ]}
                            role="switch"
                            aria-checked={settingsStore.adaptiveThinking}
                            aria-label="Adaptive Thinking"
                            disabled={locked}
                            title={locked
                                ? 'This model only supports adaptive thinking.'
                                : undefined}
                            onclick={() => {
                                if (!locked)
                                    settingsStore.adaptiveThinking =
                                        !settingsStore.adaptiveThinking;
                            }}
                        >
                            <span class="toggle-switch-thumb"></span>
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
                        aria-label="Max output tokens"
                        aria-valuenow={settingsStore.maxTokens}
                        aria-valuemin={1}
                        aria-valuemax={currentModel.params.maxOutputTokens}
                        bind:this={maxTokensBadgeEl}
                        onfocus={onMaxTokensBadgeFocus}
                        onblur={onMaxTokensBadgeBlur}
                        onkeydown={onMaxTokensBadgeKeydown}
                        >{settingsStore.maxTokens}</span
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
                        settingsStore.maxTokens =
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

            {#if showLinkedWeb}
                <div class={fieldClass}>
                    <div class={labelRowClass}>
                        <div class="flex items-center gap-1.25">
                            <label for="web-linked" class={labelClass}
                                >Web (search + fetch)</label
                            >
                            <span
                                class="info-icon relative flex items-center text-fg-muted opacity-60 cursor-default hover:opacity-100"
                                aria-label="Why search and fetch are linked"
                            >
                                <Icon name="info" />
                                <span
                                    class="info-tooltip hidden absolute bottom-[calc(100%+6px)] left-1/2 -translate-x-1/2 w-55 px-2.5 py-2 bg-surface-raised border border-border rounded-[7px] text-xs leading-normal text-fg font-normal shadow-[0_4px_16px_oklch(0%_0_0/15%)] pointer-events-none z-10"
                                    >OpenAI combines web search and web fetch
                                    into one tool, so enabling either enables
                                    both.</span
                                >
                            </span>
                        </div>
                        <button
                            id="web-linked"
                            type="button"
                            class={[
                                'toggle-switch shrink-0 relative w-8.5 h-5 p-0 rounded-full cursor-pointer transition-[background-color,border-color] duration-200',
                                linkedWebOn && 'on',
                            ]}
                            role="switch"
                            aria-checked={linkedWebOn}
                            aria-label="Web search and fetch"
                            onclick={toggleLinkedWeb}
                        >
                            <span class="toggle-switch-thumb"></span>
                        </button>
                    </div>
                </div>
            {/if}

            {#if showWebSearch}
                <div class={fieldClass}>
                    <div class={labelRowClass}>
                        <div class="flex items-center gap-1.25">
                            <label for="web-search" class={labelClass}
                                >Web Search</label
                            >
                            {#if settingsStore.providerId === 'google'}
                                <span
                                    class="info-icon relative flex items-center text-fg-muted opacity-60 cursor-default hover:opacity-100"
                                    aria-label="Google Search Suggestions notice"
                                >
                                    <Icon name="info" />
                                    <span
                                        class="info-tooltip hidden absolute bottom-[calc(100%+6px)] left-1/2 -translate-x-1/2 w-55 px-2.5 py-2 bg-surface-raised border border-border rounded-[7px] text-xs leading-normal text-fg font-normal shadow-[0_4px_16px_oklch(0%_0_0/15%)] pointer-events-none z-10"
                                        >Google requires Search Suggestions to
                                        be included when using Web Search.</span
                                    >
                                </span>
                            {/if}
                        </div>
                        <button
                            id="web-search"
                            type="button"
                            class={[
                                'toggle-switch shrink-0 relative w-8.5 h-5 p-0 rounded-full cursor-pointer transition-[background-color,border-color] duration-200',
                                settingsStore.webSearch && 'on',
                            ]}
                            role="switch"
                            aria-checked={settingsStore.webSearch}
                            aria-label="Web Search"
                            onclick={() => {
                                settingsStore.webSearch =
                                    !settingsStore.webSearch;
                            }}
                        >
                            <span class="toggle-switch-thumb"></span>
                        </button>
                    </div>
                </div>
            {/if}

            {#if showWebFetch}
                <div class={fieldClass}>
                    <div class={labelRowClass}>
                        <label for="web-fetch" class={labelClass}
                            >Web Fetch</label
                        >
                        <button
                            id="web-fetch"
                            type="button"
                            class={[
                                'toggle-switch shrink-0 relative w-8.5 h-5 p-0 rounded-full cursor-pointer transition-[background-color,border-color] duration-200',
                                settingsStore.webFetch && 'on',
                            ]}
                            role="switch"
                            aria-checked={settingsStore.webFetch}
                            aria-label="Web Fetch"
                            onclick={() => {
                                settingsStore.webFetch =
                                    !settingsStore.webFetch;
                            }}
                        >
                            <span class="toggle-switch-thumb"></span>
                        </button>
                    </div>
                </div>
            {/if}

            {#if showCodeExec}
                <div class={fieldClass}>
                    <div class={labelRowClass}>
                        <label for="code-execution" class={labelClass}
                            >Code Execution</label
                        >
                        <button
                            id="code-execution"
                            type="button"
                            class={[
                                'toggle-switch shrink-0 relative w-8.5 h-5 p-0 rounded-full cursor-pointer transition-[background-color,border-color] duration-200',
                                settingsStore.codeExecution && 'on',
                            ]}
                            role="switch"
                            aria-checked={settingsStore.codeExecution}
                            aria-label="Code Execution"
                            onclick={() => {
                                settingsStore.codeExecution =
                                    !settingsStore.codeExecution;
                            }}
                        >
                            <span class="toggle-switch-thumb"></span>
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
                <span
                    class={detailValueClass}
                    data-testid="context-window-usage"
                >
                    {#if !appLifecycle.initialized || !currentModel}
                        &nbsp;
                    {:else if chatStore.activeTokens}
                        {(
                            chatStore.activeTokens.input +
                            chatStore.activeTokens.output
                        ).toLocaleString()} / {currentModel.params.contextWindow.toLocaleString()}
                    {:else}
                        {currentModel.params.contextWindow.toLocaleString()}
                    {/if}
                </span>
            </div>
            {#if !appLifecycle.initialized || !currentModel || currentModel.params.knowledgeCutoff}
                <div class={detailRowClass}>
                    <span class={detailLabelClass}>Knowledge Cutoff</span>
                    <span class={detailValueClass}>
                        {#if appLifecycle.initialized && currentModel}
                            {currentModel.params.knowledgeCutoff}
                        {:else}
                            &nbsp;
                        {/if}
                    </span>
                </div>
            {/if}
        </div>
    </div>

    {#if settingsStore.showBranding}
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
                <rect
                    width={mcW}
                    height={mcStripeH}
                    fill="var(--color-canvas)"
                />
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
    {/if}
</aside>

<style>
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

    .toggle-switch {
        background-color: var(--color-surface-raised);
        border: 1px solid var(--color-border);
    }

    .toggle-switch.on {
        background-color: var(--color-accent-3-bg);
        border-color: var(--color-accent-3-bg);
    }

    .toggle-switch-thumb {
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

    .toggle-switch.on .toggle-switch-thumb {
        transform: translateX(14px);
    }

    .info-icon:hover .info-tooltip {
        display: block;
    }

    :global(.select-arrow) {
        position: absolute;
        right: 10px;
        top: 50%;
        transform: translateY(-50%);
        pointer-events: none;
        color: var(--color-fg);
    }
</style>
