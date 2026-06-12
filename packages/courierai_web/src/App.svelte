<script lang="ts">
    import { onMount } from 'svelte';
    import { appLifecycle } from './lib/appLifecycle.svelte';
    import ChatPanel from './lib/ChatPanel.svelte';
    import ExtensionPrompt from './lib/ExtensionPrompt.svelte';
    import FilesPane from './lib/FilesPane.svelte';
    import LegalGate from './lib/LegalGate.svelte';
    import ModelConfig from './lib/ModelConfig.svelte';
    import Sidebar from './lib/Sidebar.svelte';

    onMount(() => {
        appLifecycle.start();
    });
</script>

{#if appLifecycle.showExtensionPrompt}
    <ExtensionPrompt
        variant={appLifecycle.promptVariant}
        onlookaround={() => appLifecycle.enterDemoMode()}
    />
{/if}

{#if appLifecycle.showLegalGate}
    <LegalGate onagree={() => appLifecycle.handleLegalAgree()} />
{/if}

<div class="app-root">
    <div class="app">
        <Sidebar />
        {#if appLifecycle.view === 'files'}
            <FilesPane />
        {:else}
            <ChatPanel />
            <ModelConfig />
        {/if}
    </div>
</div>

<style>
    .app-root {
        display: flex;
        flex-direction: column;
        height: 100vh;
        overflow: hidden;
    }
    .app {
        display: flex;
        flex: 1;
        min-height: 0;
        overflow: hidden;
    }
</style>
