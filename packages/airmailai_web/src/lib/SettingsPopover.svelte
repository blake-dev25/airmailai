<script lang="ts">
    import { appMode } from './appMode.svelte';
    import AdvancedTab from './settings/AdvancedTab.svelte';
    import ApiKeysTab from './settings/ApiKeysTab.svelte';
    import ChangelogTab from './settings/ChangelogTab.svelte';
    import StorageTab from './settings/StorageTab.svelte';
    import ToolsTab from './settings/ToolsTab.svelte';
    import UiTab from './settings/UiTab.svelte';

    let { onclose }: { onclose: () => void } = $props();

    const TABS = [
        { id: 'keys', label: 'API Keys' },
        { id: 'ui', label: 'UI' },
        { id: 'tools', label: 'Tools' },
        { id: 'storage', label: 'Local Storage' },
        { id: 'advanced', label: 'Advanced' },
        { id: 'changelog', label: 'Changelog' },
    ] as const;
    type SettingsTabId = (typeof TABS)[number]['id'];

    let activeTab = $state<SettingsTabId>(appMode.isDemo ? 'ui' : 'keys');
    let storageTab = $state<StorageTab>();
    let changelogTab = $state<ChangelogTab>();

    function selectTab(tab: SettingsTabId) {
        activeTab = tab;
        if (tab === 'storage') storageTab?.open();
        if (tab === 'changelog') changelogTab?.open();
    }

    function panelClass(tab: SettingsTabId) {
        return [
            'col-start-1 row-start-1 flex flex-col gap-5 invisible',
            activeTab === tab && 'visible',
        ];
    }

    const tabBase =
        'flex-1 px-2 py-3 bg-transparent border-0 text-sm text-fg whitespace-nowrap cursor-pointer transition-[color,background-color] duration-100 hover:bg-surface-raised';
    const tabActive =
        'text-accent-fg font-medium shadow-[inset_0_-2px_0_var(--color-accent-fg)]';

    function onWindowKeydown(e: KeyboardEvent) {
        if (e.key === 'Escape') onclose();
    }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div
    class="fixed inset-0 z-49 bg-black/30"
    onclick={onclose}
    aria-hidden="true"
></div>

<div
    class="popover fixed top-1/2 left-1/2 z-50 flex w-[min(700px,calc(100vw-48px))] max-h-[calc(100vh-96px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-canvas shadow-[0_8px_40px_oklch(0%_0_0/20%)] select-none [&_input]:select-text"
    role="dialog"
    aria-label="Settings"
>
    <div class="flex border-b border-border">
        {#each TABS as tab (tab.id)}
            <button
                type="button"
                class={[tabBase, activeTab === tab.id && tabActive]}
                onclick={() => selectTab(tab.id)}
            >
                {tab.label}
            </button>
        {/each}
    </div>

    <div class="grid flex-1 overflow-y-auto p-5">
        <div class={panelClass('keys')} aria-hidden={activeTab !== 'keys'}>
            <ApiKeysTab />
        </div>
        <div class={panelClass('ui')} aria-hidden={activeTab !== 'ui'}>
            <UiTab />
        </div>
        <div class={panelClass('tools')} aria-hidden={activeTab !== 'tools'}>
            <ToolsTab />
        </div>
        <div
            class={panelClass('storage')}
            aria-hidden={activeTab !== 'storage'}
        >
            <StorageTab bind:this={storageTab} />
        </div>
        <div
            class={panelClass('advanced')}
            aria-hidden={activeTab !== 'advanced'}
        >
            <AdvancedTab />
        </div>
        <div
            class={[panelClass('changelog'), 'select-text']}
            aria-hidden={activeTab !== 'changelog'}
            style:--font-message="var(--font-sans)"
        >
            <ChangelogTab bind:this={changelogTab} />
        </div>
    </div>
</div>
