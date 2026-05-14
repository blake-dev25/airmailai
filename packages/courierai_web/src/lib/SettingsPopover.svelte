<script lang="ts">
    import type { ModelTier } from './constants';
    import { PROVIDERS, THEMES } from './constants';
    import {
        checkApiKeys,
        clearApiKey,
        saveApiKey,
        waitForExtension,
    } from './extension';
    import Icon from './Icon.svelte';

    let {
        theme = $bindable(),
        fontSizeIndex = $bindable(),
        chatWidth = $bindable(),
        smoothTextMode = $bindable(),
        submitKeystroke = $bindable(),
        modelTier = $bindable(),
        autoscroll = $bindable(),
        enableWebSearch = $bindable(),
        tagOpenRouterRequests = $bindable(),
        syncApiKeys = $bindable(),
        onclose,
        onapikeysaved,
        onapikeycleared,
    }: {
        theme: string;
        fontSizeIndex: number;
        chatWidth: number;
        smoothTextMode:
            | 'smooth'
            | 'boost-on-complete'
            | 'dump-on-complete'
            | 'raw';
        submitKeystroke: 'enter' | 'ctrl+enter';
        modelTier: ModelTier;
        autoscroll: boolean;
        enableWebSearch: boolean;
        tagOpenRouterRequests: boolean;
        syncApiKeys: boolean;
        onclose: () => void;
        onapikeysaved: (providerId: string) => void;
        onapikeycleared: (providerId: string) => void;
    } = $props();

    let activeTab = $state<'keys' | 'ui' | 'advanced' | 'changelog'>('keys');

    let showPrevious = $derived(modelTier !== 'latest');
    let showLegacy = $derived(modelTier === 'legacy');

    function togglePrevious(checked: boolean) {
        // Unchecking Previous also clears Legacy (cascade), since Legacy
        // implies Previous.
        modelTier = checked ? 'previous' : 'latest';
    }

    function toggleLegacy(checked: boolean) {
        // Checking Legacy auto-enables Previous (cascade); unchecking it
        // keeps Previous enabled.
        modelTier = checked ? 'legacy' : 'previous';
    }

    let keyInputs = $state<Record<string, string>>(
        Object.fromEntries(PROVIDERS.map((p) => [p.id, '']))
    );

    let savedKeys = $state<Record<string, boolean>>(
        Object.fromEntries(PROVIDERS.map((p) => [p.id, false]))
    );

    async function refreshSavedKeys() {
        await waitForExtension();
        savedKeys = await checkApiKeys(PROVIDERS.map((p) => p.id));
    }

    $effect(() => {
        refreshSavedKeys();
    });

    async function handleSave(providerId: string) {
        const key = keyInputs[providerId].trim();
        if (!key) return;
        const ok = await saveApiKey(providerId, key, syncApiKeys);
        if (ok) {
            keyInputs[providerId] = '';
            savedKeys[providerId] = true;
            onapikeysaved(providerId);
        }
    }

    async function handleClear(providerId: string) {
        const ok = await clearApiKey(providerId);
        if (ok) {
            savedKeys[providerId] = false;
            onapikeycleared(providerId);
        }
    }

    const tabBase =
        'flex-1 px-4 py-3 bg-transparent border-0 text-sm text-fg cursor-pointer transition-[color,background-color] duration-100 hover:bg-surface-raised';
    const tabActive =
        'text-accent-fg font-medium shadow-[inset_0_-2px_0_var(--color-accent-fg)]';

    const rowBase = 'flex flex-col gap-2';
    const themeRow = 'flex-row! items-center justify-between';

    const labelClass = 'text-sm text-fg font-medium';

    const selectClass =
        'w-auto px-2.5 py-[7px] bg-surface-raised border border-border rounded-md text-sm text-fg cursor-pointer';

    const rangeClass =
        'range-styled appearance-none w-full h-1 bg-surface-raised border-0 rounded p-0 cursor-pointer outline-none';

    const switchClass =
        'ios-switch shrink-0 relative w-8.5 h-5 p-0 rounded-full cursor-pointer transition-[background-color,border-color] duration-200';

    const tdBase = 'py-2 px-3 text-fg align-middle';
</script>

<div
    class="fixed inset-0 z-49 bg-black/30"
    onclick={onclose}
    aria-hidden="true"
></div>

<div
    class="popover fixed top-1/2 left-1/2 z-50 flex w-[min(560px,calc(100vw-48px))] max-h-[calc(100vh-96px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-canvas shadow-[0_8px_40px_oklch(0%_0_0/20%)] select-none [&_input]:select-text"
    role="dialog"
    aria-label="Settings"
>
    <div class="flex border-b border-border">
        <button
            type="button"
            class={[tabBase, activeTab === 'keys' && tabActive]}
            onclick={() => (activeTab = 'keys')}
        >
            API Keys
        </button>
        <button
            type="button"
            class={[tabBase, activeTab === 'ui' && tabActive]}
            onclick={() => (activeTab = 'ui')}
        >
            UI
        </button>
        <button
            type="button"
            class={[tabBase, activeTab === 'advanced' && tabActive]}
            onclick={() => (activeTab = 'advanced')}
        >
            Advanced
        </button>
        <button
            type="button"
            class={[tabBase, activeTab === 'changelog' && tabActive]}
            onclick={() => (activeTab = 'changelog')}
        >
            Changelog
        </button>
    </div>

    <div class="grid flex-1 overflow-y-auto p-5">
        <!-- Tab panels share grid cell so popover height = tallest panel -->
        <div
            class={[
                'col-start-1 row-start-1 flex flex-col gap-5 invisible',
                activeTab === 'keys' && 'visible',
            ]}
            aria-hidden={activeTab !== 'keys'}
        >
            <table class="w-full border-collapse text-sm">
                <thead>
                    <tr>
                        <th
                            class="text-left font-medium text-fg px-3 pb-2.5 border-b border-border"
                            >Provider</th
                        >
                        <th
                            class="text-center font-medium text-fg px-3 pb-2.5 border-b border-border"
                            >Saved</th
                        >
                        <th
                            class="text-left font-medium text-fg px-3 pb-2.5 border-b border-border w-full"
                            >API Key</th
                        >
                        <th
                            class="text-left font-medium text-fg px-3 pb-2.5 border-b border-border whitespace-nowrap"
                            >Options</th
                        >
                    </tr>
                </thead>
                <tbody>
                    {#each PROVIDERS as provider, i (provider.id)}
                        {@const isLast = i === PROVIDERS.length - 1}
                        <tr>
                            <td
                                class={[
                                    tdBase,
                                    'font-medium whitespace-nowrap',
                                    !isLast && 'border-b border-border',
                                ]}>{provider.name}</td
                            >
                            <td
                                class={[
                                    tdBase,
                                    'text-center [&_svg]:block [&_svg]:mx-auto',
                                    !isLast && 'border-b border-border',
                                ]}
                            >
                                {#if savedKeys[provider.id]}
                                    <Icon name="check" class="icon-check" />
                                {:else}
                                    <Icon
                                        name="close"
                                        size={15}
                                        class="icon-x"
                                    />
                                {/if}
                            </td>
                            <td
                                class={[
                                    tdBase,
                                    'w-full',
                                    !isLast && 'border-b border-border',
                                ]}
                            >
                                <input
                                    class="w-full px-2.5 py-1.5 bg-surface-raised border border-border rounded-md text-sm text-fg font-mono box-border outline-none transition-[border-color] duration-150 focus:border-accent-fg placeholder:font-sans placeholder:text-fg-muted"
                                    type="password"
                                    placeholder="Paste key..."
                                    bind:value={keyInputs[provider.id]}
                                    onkeydown={(e) => {
                                        if (e.key === 'Enter')
                                            handleSave(provider.id);
                                    }}
                                />
                            </td>
                            <td
                                class={[
                                    tdBase,
                                    'whitespace-nowrap',
                                    !isLast && 'border-b border-border',
                                ]}
                            >
                                <div class="flex items-center gap-1.5">
                                    <button
                                        type="button"
                                        class="shrink-0 px-2.5 py-1.25 border-0 rounded-md text-xs font-medium cursor-pointer whitespace-nowrap transition-[background-color,color,opacity] duration-150 disabled:opacity-[0.35] disabled:cursor-not-allowed bg-accent-bg text-on-accent-bg enabled:hover:bg-accent-bg-hover enabled:hover:text-on-accent-bg-hover"
                                        disabled={!keyInputs[
                                            provider.id
                                        ].trim()}
                                        onclick={() => handleSave(provider.id)}
                                    >
                                        Save
                                    </button>
                                    <button
                                        type="button"
                                        class="shrink-0 px-2.5 py-1.25 border border-border rounded-md text-xs font-medium cursor-pointer whitespace-nowrap transition-[background-color,opacity] duration-150 disabled:opacity-[0.35] disabled:cursor-not-allowed bg-surface-raised text-fg enabled:hover:bg-surface-sunken"
                                        disabled={!savedKeys[provider.id]}
                                        onclick={() => handleClear(provider.id)}
                                    >
                                        Clear
                                    </button>
                                </div>
                            </td>
                        </tr>
                    {/each}
                </tbody>
            </table>
        </div>

        <div
            class={[
                'col-start-1 row-start-1 flex flex-col gap-5 invisible',
                activeTab === 'ui' && 'visible',
            ]}
            aria-hidden={activeTab !== 'ui'}
        >
            <div class={[rowBase, themeRow]}>
                <label for="theme-select" class={labelClass}>Theme</label>
                <select
                    id="theme-select"
                    class={selectClass}
                    bind:value={theme}
                >
                    {#each THEMES as t (t.id)}
                        <option value={t.id}>{t.name}</option>
                    {/each}
                </select>
            </div>
            <div class={rowBase}>
                <label for="font-size" class={labelClass}>Text Size</label>
                <input
                    type="range"
                    id="font-size"
                    class={rangeClass}
                    min="0"
                    max="5"
                    step="1"
                    bind:value={fontSizeIndex}
                />
                <div
                    class="flex justify-between text-[0.6875rem] text-fg -mt-1"
                >
                    <span>Smaller</span>
                    <span>Larger</span>
                </div>
            </div>
            <div class={rowBase}>
                <label for="chat-width" class={labelClass}>Chat Width</label>
                <input
                    type="range"
                    id="chat-width"
                    class={rangeClass}
                    min="0"
                    max="100"
                    step="1"
                    bind:value={chatWidth}
                />
                <div
                    class="flex justify-between text-[0.6875rem] text-fg -mt-1"
                >
                    <span>Narrower</span>
                    <span>Wider</span>
                </div>
            </div>
            <div class={[rowBase, themeRow]}>
                <label for="submit-keystroke" class={labelClass}
                    >Submit Keystroke</label
                >
                <select
                    id="submit-keystroke"
                    class={selectClass}
                    bind:value={submitKeystroke}
                >
                    <option value="enter">Enter</option>
                    <option value="ctrl+enter">Control+Enter</option>
                </select>
            </div>
            <div class={[rowBase, themeRow]}>
                <label for="autoscroll" class={labelClass}>Autoscroll</label>
                <button
                    id="autoscroll"
                    type="button"
                    class={switchClass}
                    class:on={autoscroll}
                    role="switch"
                    aria-checked={autoscroll}
                    aria-label="Autoscroll"
                    onclick={() => {
                        autoscroll = !autoscroll;
                    }}
                >
                    <span class="ios-switch-thumb"></span>
                </button>
            </div>
            <div class={[rowBase, themeRow]}>
                <label for="show-previous" class={labelClass}
                    >Show Previous Generation Models</label
                >
                <button
                    id="show-previous"
                    type="button"
                    class={switchClass}
                    class:on={showPrevious}
                    role="switch"
                    aria-checked={showPrevious}
                    aria-label="Show Previous Generation Models"
                    onclick={() => {
                        togglePrevious(!showPrevious);
                    }}
                >
                    <span class="ios-switch-thumb"></span>
                </button>
            </div>
        </div>

        <div
            class={[
                'col-start-1 row-start-1 flex flex-col gap-5 invisible',
                activeTab === 'advanced' && 'visible',
            ]}
            aria-hidden={activeTab !== 'advanced'}
        >
            <div class={[rowBase, themeRow]}>
                <label for="sync-api-keys" class={labelClass}
                    >Sync API Keys Through Browser Account</label
                >
                <button
                    id="sync-api-keys"
                    type="button"
                    class={switchClass}
                    class:on={syncApiKeys}
                    role="switch"
                    aria-checked={syncApiKeys}
                    aria-label="Sync API Keys Through Browser Account"
                    onclick={() => {
                        syncApiKeys = !syncApiKeys;
                        setTimeout(refreshSavedKeys, 500);
                    }}
                >
                    <span class="ios-switch-thumb"></span>
                </button>
            </div>
            <div class={[rowBase, themeRow]}>
                <label for="enable-web-search" class={labelClass}
                    >Enable Web Search</label
                >
                <button
                    id="enable-web-search"
                    type="button"
                    class={switchClass}
                    class:on={enableWebSearch}
                    role="switch"
                    aria-checked={enableWebSearch}
                    aria-label="Enable Web Search"
                    onclick={() => {
                        enableWebSearch = !enableWebSearch;
                    }}
                >
                    <span class="ios-switch-thumb"></span>
                </button>
            </div>
            <div class={[rowBase, themeRow]}>
                <div class="flex items-center gap-1.25">
                    <label for="smooth-text-mode" class={labelClass}
                        >Smooth Text Rendering</label
                    >
                    <span
                        class="info-icon relative flex items-center text-fg-muted opacity-60 cursor-default hover:opacity-100"
                        aria-label="About smooth text rendering"
                    >
                        <Icon name="info" />
                        <span
                            class="info-tooltip hidden absolute bottom-[calc(100%+6px)] left-1/2 -translate-x-1/2 w-55 px-2.5 py-2 bg-surface-raised border border-border rounded-[7px] text-xs leading-normal text-fg font-normal shadow-[0_4px_16px_oklch(0%_0_0/15%)] pointer-events-none z-10"
                            >Changes how AI messages are displayed. Sorted from
                            slow/pretty to fast/less pretty.</span
                        >
                    </span>
                </div>
                <select
                    id="smooth-text-mode"
                    class={selectClass}
                    bind:value={smoothTextMode}
                >
                    <option value="smooth">Normal rendering</option>
                    <option value="boost-on-complete"
                        >Fast rendering upon message completion</option
                    >
                    <option value="dump-on-complete"
                        >Render all text upon message completion</option
                    >
                    <option value="raw"
                        >Render text chunks as streamed from API</option
                    >
                </select>
            </div>
            <div class={[rowBase, themeRow]}>
                <label for="show-legacy" class={labelClass}
                    >Show Legacy Models</label
                >
                <button
                    id="show-legacy"
                    type="button"
                    class={switchClass}
                    class:on={showLegacy}
                    role="switch"
                    aria-checked={showLegacy}
                    aria-label="Show Legacy Models"
                    onclick={() => {
                        toggleLegacy(!showLegacy);
                    }}
                >
                    <span class="ios-switch-thumb"></span>
                </button>
            </div>
            <div class={[rowBase, themeRow]}>
                <label for="tag-openrouter" class={labelClass}
                    >Tag OpenRouter requests with 'CourierAI' for <a
                        href="https://openrouter.ai/apps?url=https%3A%2F%2Fcourierai.net%2F"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="text-accent-fg no-underline hover:underline"
                        onclick={(e) => e.stopPropagation()}>app tracking ↗</a
                    ></label
                >
                <button
                    id="tag-openrouter"
                    type="button"
                    class={switchClass}
                    class:on={tagOpenRouterRequests}
                    role="switch"
                    aria-checked={tagOpenRouterRequests}
                    aria-label="Tag OpenRouter requests with CourierAI for app tracking"
                    onclick={() => {
                        tagOpenRouterRequests = !tagOpenRouterRequests;
                    }}
                >
                    <span class="ios-switch-thumb"></span>
                </button>
            </div>
        </div>

        <div
            class={[
                'col-start-1 row-start-1 flex flex-col gap-5 invisible select-text',
                activeTab === 'changelog' && 'visible',
            ]}
            aria-hidden={activeTab !== 'changelog'}
        >
            <h3 class="text-sm font-semibold text-fg m-0 py-1">
                v{__APP_VERSION__}
            </h3>
            <p class="text-sm text-fg m-0 py-1">TODO - add changelog</p>
        </div>
    </div>
</div>

<style>
    /* CSS islands — pseudo-element-heavy patterns that don't translate well to utilities */

    /* Range slider thumb (used on Text Size + Chat Width sliders) */
    .range-styled::-webkit-slider-thumb {
        -webkit-appearance: none;
        appearance: none;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background-color: var(--color-accent-bg);
        cursor: pointer;
        transition:
            background-color 0.15s,
            transform 0.1s;
    }

    .range-styled::-webkit-slider-thumb:hover {
        background-color: var(--color-accent-bg-hover);
        transform: scale(1.15);
    }

    .range-styled::-moz-range-thumb {
        width: 16px;
        height: 16px;
        border: none;
        border-radius: 50%;
        background-color: var(--color-accent-bg);
        cursor: pointer;
    }

    /* iOS-style switch — matches the ModelConfig sidebar toggle pattern */
    .ios-switch {
        background-color: var(--color-surface-raised);
        border: 1px solid var(--color-border);
    }

    .ios-switch.on {
        background-color: var(--color-accent-bg);
        border-color: var(--color-accent-bg);
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

    /* Info-icon tooltip: hover-driven visibility on a child via parent state */
    .info-icon:hover .info-tooltip {
        display: block;
    }

    /* Icon overrides for the API keys table */
    :global(.icon-check) {
        color: #4caf6e;
    }

    :global(.icon-x) {
        color: var(--color-fg-muted);
    }
</style>
