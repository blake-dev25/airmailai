<script lang="ts">
    import type { CustomModelConfig } from '@airmailai/shared';
    import { appLifecycle } from './appLifecycle.svelte';
    import { CUSTOM_PROVIDER_TOOLS } from './models/custom';
    import { settingsStore } from './settingsStore.svelte';
    import ToggleSwitch from './ToggleSwitch.svelte';

    let { config }: { config: CustomModelConfig } = $props();
    let provider = $derived(settingsStore.providerId);
    let tools = $derived(CUSTOM_PROVIDER_TOOLS[provider]);
    let toolFields = $derived([
        ...(tools?.webSearch && settingsStore.enableWebSearch
            ? [{ key: 'webSearch', label: 'Web Search' }]
            : []),
        ...(tools?.webFetch && settingsStore.enableWebFetch
            ? [{ key: 'webFetch', label: 'Web Fetch' }]
            : []),
        ...(tools?.codeExecution && settingsStore.enableCodeExecution
            ? [{ key: 'codeExecution', label: 'Code Execution' }]
            : []),
    ] as {
        key: 'webSearch' | 'webFetch' | 'codeExecution';
        label: string;
    }[]);
    let fields = $derived([
        ...(provider !== 'anthropic'
            ? [{ key: 'temperature', label: 'Temperature' }]
            : []),
        { key: 'maxTokens', label: 'Max Output Tokens' },
        ...(provider !== 'anthropic' || config.adaptiveThinking
            ? [{ key: 'thinkingLevel', label: 'Thinking Level' }]
            : []),
        ...(provider === 'google' ||
        (provider === 'anthropic' && !config.adaptiveThinking)
            ? [{ key: 'thinkingBudget', label: 'Thinking Budget (Tokens)' }]
            : []),
        ...(provider === 'anthropic' ? toolFields : []),
    ] as {
        key: Exclude<keyof CustomModelConfig, 'adaptiveThinking'>;
        label: string;
    }[]);
    let toggles = $derived([
        ...(provider === 'anthropic'
            ? [{ key: 'adaptiveThinking', label: 'Adaptive Thinking' }]
            : []),
        ...(provider !== 'anthropic' ? toolFields : []),
    ] as {
        key: 'adaptiveThinking' | 'webSearch' | 'webFetch' | 'codeExecution';
        label: string;
    }[]);
    const inputClass =
        'w-full min-w-0 rounded-md border border-border bg-surface-raised px-2.5 py-2 text-sm text-fg outline-none focus:border-accent-3-fg';
</script>

<div class="flex flex-col gap-2">
    <label for="model" class="text-sm font-medium text-fg">Model</label>
    <input
        id="model"
        type="text"
        class={inputClass}
        bind:value={settingsStore.modelId}
        disabled={appLifecycle.bootPhase !== 'ready'}
        autocomplete="off"
        spellcheck="false"
    />
</div>

{#each fields as field (field.key)}
    <div class="flex flex-col gap-2">
        <label for={`custom-${field.key}`} class="text-sm font-medium text-fg"
            >{field.label}</label
        >
        <input
            id={`custom-${field.key}`}
            type="text"
            class={inputClass}
            bind:value={
                () => {
                    const value = config[field.key];
                    return typeof value === 'string' ? value : '';
                },
                (value) => {
                    config[field.key] = value;
                }
            }
            disabled={appLifecycle.bootPhase !== 'ready'}
            autocomplete="off"
            spellcheck="false"
        />
    </div>
{/each}

{#each toggles as toggle (toggle.key)}
    <div class="flex items-center justify-between">
        <label for={`custom-${toggle.key}`} class="text-sm font-medium text-fg"
            >{toggle.label}</label
        >
        <ToggleSwitch
            id={`custom-${toggle.key}`}
            checked={config[toggle.key] === true}
            label={toggle.label}
            disabled={appLifecycle.bootPhase !== 'ready'}
            onchange={(checked) => {
                config[toggle.key] = checked;
            }}
        />
    </div>
{/each}
