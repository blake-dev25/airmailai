<script lang="ts">
    import { untrack } from 'svelte';
    import { appLifecycle } from './appLifecycle.svelte';
    import { chatStore } from './chatStore.svelte';
    import {
        defaultModelForProvider,
        filterProvidersByTier,
        type ModelOption,
        type VisibleModelTier,
        visibleModelTier,
    } from './constants';
    import Icon from './Icon.svelte';
    import Dropdown from './Dropdown.svelte';
    import ModelPicker, { type ModelGroup } from './ModelPicker.svelte';
    import { providersStore } from './providersStore.svelte';
    import { settingsStore } from './settingsStore.svelte';
    import Stripes from './Stripes.svelte';

    const TIER_ORDER: VisibleModelTier[] = ['latest', 'previous', 'legacy'];
    const TIER_LABELS: Record<VisibleModelTier, string> = {
        latest: 'Latest',
        previous: 'Previous',
        legacy: 'Legacy',
    };
    const OPENROUTER_EMPTY_LABEL =
        'Please load an OpenRouter API key to download their model catalog.';

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
            // *** Vendor order (premier `~` groups first) is already set by
            // buildOpenRouterProvider; this only strips the `~` for the label and
            // flags the group so the picker shows the premier star.
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

        const byTier = new Map<VisibleModelTier, ModelOption[]>();
        for (const m of provider.models) {
            if (!inTier.has(m.id)) continue;
            const tier = visibleModelTier(m.id);
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

    function onProviderChange(id: string) {
        settingsStore.providerId = id;
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

    let contextUsed = $derived(
        chatStore.activeTokens
            ? chatStore.activeTokens.input + chatStore.activeTokens.output
            : null
    );
    let contextNearLimit = $derived(
        contextUsed !== null &&
            !!currentModel &&
            contextUsed > currentModel.params.contextWindow * 0.9
    );

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
    style="--toggle-on: var(--color-accent-3-bg); --range-thumb: var(--color-accent-3-bg); --range-thumb-hover: var(--color-accent-3-bg-hover);"
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
            <Dropdown
                id="provider"
                options={appLifecycle.initialized ? providerOptions : []}
                value={settingsStore.providerId}
                onchange={onProviderChange}
                disabled={!appLifecycle.initialized}
                emptyLabel="Loading providers..."
                fullWidth
            />
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
                            {:else if settingsStore.providerId === 'anthropic'}
                                <span
                                    class="info-icon relative flex items-center text-fg-muted opacity-60 cursor-default hover:opacity-100"
                                    aria-label="Anthropic web search requirement"
                                >
                                    <Icon name="info" />
                                    <span
                                        class="info-tooltip hidden absolute bottom-full left-1/2 -translate-x-1/2 pb-1.5 z-10"
                                    >
                                        <span
                                            class="block w-55 px-2.5 py-2 bg-surface-raised border border-border rounded-[7px] text-xs leading-normal text-fg font-normal shadow-[0_4px_16px_oklch(0%_0_0/15%)]"
                                            >Anthropic requires web search to be
                                            turned on in <a
                                                href="https://platform.claude.com/settings/privacy"
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                class="text-accent-fg hover:underline"
                                                >org settings</a
                                            >.</span
                                        >
                                    </span>
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
                    class={[
                        detailValueClass,
                        contextNearLimit &&
                            'text-accent-fg! inline-flex items-center gap-1',
                    ]}
                    data-testid="context-window-usage"
                    title={contextNearLimit
                        ? "This conversation is approaching the model's context limit."
                        : undefined}
                >
                    {#if !appLifecycle.initialized || !currentModel}
                        &nbsp;
                    {:else if contextUsed !== null}
                        {contextUsed.toLocaleString()} / {currentModel.params.contextWindow.toLocaleString()}
                        {#if contextNearLimit}
                            <Icon name="circle-alert" size={12} />
                        {/if}
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

    {#if settingsStore.brandingMode === 'on'}
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
    {/if}

    {#if settingsStore.brandingMode !== 'off'}
        <Stripes width={272} shift={-8} />
    {/if}
</aside>
