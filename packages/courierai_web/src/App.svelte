<script lang="ts">
    import { onMount } from 'svelte';
    import { appLifecycle } from './lib/appLifecycle.svelte';
    import ChatPanel from './lib/ChatPanel.svelte';
    import ExtensionPrompt from './lib/ExtensionPrompt.svelte';
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
        <ChatPanel />
        <ModelConfig />
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
