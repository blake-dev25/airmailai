<script lang="ts">
    import type { ModelTier } from './constants';
    import { PROVIDERS, THEMES } from './constants';
    import {
        checkApiKeys,
        clearApiKey,
        saveApiKey,
        waitForExtension,
    } from './extension';

    let {
        theme = $bindable(),
        fontSizeIndex = $bindable(),
        chatWidth = $bindable(),
        smoothTextMode = $bindable(),
        submitKeystroke = $bindable(),
        modelTier = $bindable(),
        onclose,
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
        onclose: () => void;
    } = $props();

    let activeTab = $state<'keys' | 'ui' | 'changelog'>('keys');

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

    // Input values (cleared after saving — we never display stored keys)
    let keyInputs = $state<Record<string, string>>(
        Object.fromEntries(PROVIDERS.map((p) => [p.id, ''])),
    );

    // Which providers have a key saved in the extension
    let savedKeys = $state<Record<string, boolean>>(
        Object.fromEntries(PROVIDERS.map((p) => [p.id, false])),
    );

    $effect(() => {
        waitForExtension().then(() => {
            checkApiKeys(PROVIDERS.map((p) => p.id)).then((result) => {
                savedKeys = result;
            });
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

    async function handleClear(providerId: string) {
        const ok = await clearApiKey(providerId);
        if (ok) savedKeys[providerId] = false;
    }
</script>

<div class="backdrop" onclick={onclose} aria-hidden="true"></div>

<div class="popover" role="dialog" aria-label="Settings">
    <div class="tabs">
        <button
            type="button"
            class:active={activeTab === 'keys'}
            onclick={() => (activeTab = 'keys')}
        >
            API Keys
        </button>
        <button
            type="button"
            class:active={activeTab === 'ui'}
            onclick={() => (activeTab = 'ui')}
        >
            UI
        </button>
        <button
            type="button"
            class:active={activeTab === 'changelog'}
            onclick={() => (activeTab = 'changelog')}
        >
            Changelog
        </button>
    </div>

    <div class="content">
        <div
            class="tab-panel"
            class:active={activeTab === 'keys'}
            aria-hidden={activeTab !== 'keys'}
        >
            <table class="keys-table">
                <thead>
                    <tr>
                        <th>Provider</th>
                        <th>Saved</th>
                        <th>API Key</th>
                        <th>Options</th>
                    </tr>
                </thead>
                <tbody>
                    {#each PROVIDERS as provider (provider.id)}
                        <tr>
                            <td class="provider-name">{provider.name}</td>
                            <td class="saved-cell">
                                {#if savedKeys[provider.id]}
                                    <svg
                                        width="15"
                                        height="15"
                                        viewBox="0 0 15 15"
                                        fill="none"
                                        role="img"
                                        aria-label="Saved"
                                        class="icon-check"
                                    >
                                        <path
                                            d="M2.5 7.5l3.5 3.5 6.5-6.5"
                                            stroke="currentColor"
                                            stroke-width="1.75"
                                            stroke-linecap="round"
                                            stroke-linejoin="round"
                                        />
                                    </svg>
                                {:else}
                                    <svg
                                        width="15"
                                        height="15"
                                        viewBox="0 0 15 15"
                                        fill="none"
                                        role="img"
                                        aria-label="Not saved"
                                        class="icon-x"
                                    >
                                        <path
                                            d="M3 3l9 9M12 3l-9 9"
                                            stroke="currentColor"
                                            stroke-width="1.75"
                                            stroke-linecap="round"
                                        />
                                    </svg>
                                {/if}
                            </td>
                            <td class="key-cell">
                                <input
                                    class="key-input"
                                    type="password"
                                    placeholder="Paste key…"
                                    bind:value={keyInputs[provider.id]}
                                    onkeydown={(e) => {
                                        if (e.key === 'Enter')
                                            handleSave(provider.id);
                                    }}
                                />
                            </td>
                            <td class="options-cell">
                                <div class="options-btns">
                                    <button
                                        type="button"
                                        class="action-btn save-btn"
                                        disabled={!keyInputs[
                                            provider.id
                                        ].trim()}
                                        onclick={() => handleSave(provider.id)}
                                    >
                                        Save
                                    </button>
                                    <button
                                        type="button"
                                        class="action-btn clear-btn"
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
            class="tab-panel"
            class:active={activeTab === 'ui'}
            aria-hidden={activeTab !== 'ui'}
        >
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
                <input
                    type="range"
                    id="font-size"
                    min="0"
                    max="5"
                    step="1"
                    bind:value={fontSizeIndex}
                />
                <div class="range-hints">
                    <span>Smaller</span>
                    <span>Larger</span>
                </div>
            </div>
            <div class="row">
                <label for="chat-width">Chat Width</label>
                <input
                    type="range"
                    id="chat-width"
                    min="0"
                    max="100"
                    step="1"
                    bind:value={chatWidth}
                />
                <div class="range-hints">
                    <span>Narrower</span>
                    <span>Wider</span>
                </div>
            </div>
            <div class="row theme-row">
                <label for="submit-keystroke">Submit Keystroke</label>
                <select id="submit-keystroke" bind:value={submitKeystroke}>
                    <option value="enter">Enter</option>
                    <option value="ctrl+enter">Control+Enter</option>
                </select>
            </div>
            <div class="row theme-row">
                <label for="show-previous"
                    >Show Previous Generation Models</label
                >
                <input
                    id="show-previous"
                    type="checkbox"
                    checked={showPrevious}
                    onchange={(e) =>
                        togglePrevious(
                            (e.currentTarget as HTMLInputElement).checked,
                        )}
                />
            </div>
            <div class="row theme-row">
                <div class="label-with-info">
                    <label for="smooth-text-mode">Smooth Text Rendering</label>
                    <span
                        class="info-icon"
                        aria-label="About smooth text rendering"
                    >
                        <svg
                            width="13"
                            height="13"
                            viewBox="0 0 13 13"
                            fill="none"
                            aria-hidden="true"
                        >
                            <circle
                                cx="6.5"
                                cy="6.5"
                                r="5.75"
                                stroke="currentColor"
                                stroke-width="1.25"
                            />
                            <path
                                d="M6.5 5.5v4"
                                stroke="currentColor"
                                stroke-width="1.25"
                                stroke-linecap="round"
                            />
                            <circle
                                cx="6.5"
                                cy="3.75"
                                r="0.65"
                                fill="currentColor"
                            />
                        </svg>
                        <span class="info-tooltip"
                            >Changes how AI messages are displayed. Sorted from
                            slow/pretty to fast/less pretty.</span
                        >
                    </span>
                </div>
                <select id="smooth-text-mode" bind:value={smoothTextMode}>
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

            <details class="advanced">
                <summary>Advanced</summary>
                <div class="row theme-row">
                    <label for="show-legacy">Show Legacy Models</label>
                    <input
                        id="show-legacy"
                        type="checkbox"
                        checked={showLegacy}
                        onchange={(e) =>
                            toggleLegacy(
                                (e.currentTarget as HTMLInputElement).checked,
                            )}
                    />
                </div>
            </details>
        </div>

        <div
            class="tab-panel changelog-panel"
            class:active={activeTab === 'changelog'}
            aria-hidden={activeTab !== 'changelog'}
        >
            <h3 class="version-heading">v{__APP_VERSION__}</h3>
            <p class="todo">TODO - add changelog</p>
        </div>
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
        -webkit-user-select: none;
        user-select: none;
    }

    .popover input {
        -webkit-user-select: text;
        user-select: text;
    }

    .changelog-panel {
        -webkit-user-select: text;
        user-select: text;
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
        transition:
            color 0.1s,
            background-color 0.1s;
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
        display: grid;
    }

    /* All panels occupy the same grid cell — height = tallest panel */
    .tab-panel {
        grid-area: 1 / 1;
        display: flex;
        flex-direction: column;
        gap: 20px;
        visibility: hidden;
    }

    .tab-panel.active {
        visibility: visible;
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
        transition:
            background-color 0.15s,
            transform 0.1s;
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

    /* Checkbox — accent-tinted to match the rest of the UI */
    input[type='checkbox'] {
        flex-shrink: 0;
        width: 16px;
        height: 16px;
        margin: 0;
        accent-color: var(--color-accent);
        cursor: pointer;
    }

    /* Advanced expando — sits at the bottom of the UI panel */
    .advanced {
        margin-top: -8px;
        border-top: 1px solid var(--color-border);
        padding-top: 16px;
    }

    .advanced > summary {
        list-style: none;
        cursor: pointer;
        font-size: 0.75rem;
        font-weight: 500;
        color: var(--color-text-muted);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        padding: 2px 0;
        user-select: none;
        -webkit-user-select: none;
    }

    .advanced > summary::-webkit-details-marker {
        display: none;
    }

    .advanced > summary::before {
        content: '▸';
        display: inline-block;
        margin-right: 6px;
        transition: transform 0.15s;
    }

    .advanced[open] > summary::before {
        transform: rotate(90deg);
    }

    .advanced > .row {
        margin-top: 14px;
    }

    .label-with-info {
        display: flex;
        align-items: center;
        gap: 5px;
    }

    .info-icon {
        position: relative;
        display: flex;
        align-items: center;
        color: var(--color-text-muted);
        cursor: default;
        opacity: 0.6;
    }

    .info-icon:hover {
        opacity: 1;
    }

    .info-tooltip {
        display: none;
        position: absolute;
        bottom: calc(100% + 6px);
        left: 50%;
        translate: -50% 0;
        width: 220px;
        padding: 8px 10px;
        background-color: var(--color-surface-raised);
        border: 1px solid var(--color-border);
        border-radius: 7px;
        font-size: 0.75rem;
        line-height: 1.5;
        color: var(--color-text);
        font-weight: 400;
        box-shadow: 0 4px 16px oklch(0% 0 0 / 15%);
        pointer-events: none;
        z-index: 10;
    }

    .info-icon:hover .info-tooltip {
        display: block;
    }

    /* API Keys table */
    .keys-table {
        width: 100%;
        table-layout: auto;
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

    .keys-table th:nth-child(2),
    .keys-table td:nth-child(2) {
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
        font-weight: 500;
        white-space: nowrap;
    }

    .key-cell {
        width: 100%;
    }

    .options-cell {
        white-space: nowrap;
    }

    .options-btns {
        display: flex;
        gap: 6px;
        align-items: center;
    }

    .action-btn {
        flex-shrink: 0;
        padding: 5px 10px;
        border: none;
        border-radius: 6px;
        font-size: 0.75rem;
        font-weight: 500;
        cursor: pointer;
        transition:
            background-color 0.15s,
            opacity 0.15s;
        white-space: nowrap;
    }

    .action-btn:disabled {
        opacity: 0.35;
        cursor: not-allowed;
    }

    .save-btn {
        background-color: var(--color-accent);
        color: var(--color-bg);
    }

    .save-btn:hover:not(:disabled) {
        background-color: var(--color-accent-hover);
    }

    .clear-btn {
        background-color: var(--color-surface-raised);
        color: var(--color-text);
        border: 1px solid var(--color-border);
    }

    .clear-btn:hover:not(:disabled) {
        background-color: var(--color-surface-sunken);
    }

    .key-input {
        width: 100%;
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
        text-align: center;
    }

    .saved-cell svg {
        display: block;
        margin: 0 auto;
    }

    .icon-check {
        color: #4caf6e;
    }

    .icon-x {
        color: var(--color-text-muted);
    }

    .version-heading {
        font-size: 0.875rem;
        font-weight: 600;
        color: var(--color-text);
        margin: 0;
        padding: 4px 0;
    }

    .todo {
        font-size: 0.8125rem;
        color: var(--color-text);
        margin: 0;
        padding: 4px 0;
    }
</style>
