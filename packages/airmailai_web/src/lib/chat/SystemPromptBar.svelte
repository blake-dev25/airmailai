<script lang="ts">
    import { appMode } from '../appMode.svelte';
    import { EXTENSION_STORE_URL } from '../constants';
    import Icon from '../Icon.svelte';
    import { settingsStore } from '../settingsStore.svelte';

    let systemExpanded = $state(false);
</script>

<div class="relative shrink-0 bg-canvas border-b border-border">
    <button
        type="button"
        class="flex items-center gap-2 w-full h-11 px-4 bg-transparent border-0 text-sm font-medium text-fg cursor-pointer text-left transition-[color] duration-100 box-border"
        onclick={() => (systemExpanded = !systemExpanded)}
    >
        <Icon
            name="chevron-down"
            class="transition-transform duration-200 {systemExpanded
                ? 'rotate-180'
                : ''}"
        />
        <span>System Prompt</span>
        {#if settingsStore.systemPrompt.trim()}
            <span
                class="w-1.5 h-1.5 rounded-full bg-accent-bg shrink-0"
                aria-label="System prompt is set"
            ></span>
        {/if}
    </button>
    {#if appMode.isDemo}
        <a
            href={EXTENSION_STORE_URL}
            target="_blank"
            rel="noopener noreferrer"
            class="absolute top-0 right-4 h-11 flex items-center gap-1.25 px-2 bg-transparent border-0 font-sans text-xs font-medium text-accent-fg no-underline cursor-pointer rounded transition-[color,background-color] duration-150 hover:text-accent-fg-hover hover:underline"
        >
            <span>Install the extension</span>
            <Icon name="external-link" />
        </a>
    {/if}
    {#if systemExpanded}
        <div class="px-4 pb-3">
            <textarea
                class="w-full min-h-20 max-h-45 px-3 py-2.5 bg-canvas border border-border rounded-lg text-fg font-sans text-sm leading-[1.6] resize-y box-border outline-none transition-[border-color] duration-150 focus:border-accent-fg placeholder:text-fg-muted"
                placeholder="Give the model a persona, instructions, or context..."
                bind:value={settingsStore.systemPrompt}></textarea>
        </div>
    {/if}
</div>
