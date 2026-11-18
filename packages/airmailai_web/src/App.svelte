<script lang="ts">
    import { onMount } from 'svelte';
    import { appLifecycle } from './lib/appLifecycle.svelte';
    import { appMode } from './lib/appMode.svelte';
    import ChatPanel from './lib/ChatPanel.svelte';
    import { reportAppError } from './lib/errorStore.svelte';
    import ExtensionPrompt from './lib/ExtensionPrompt.svelte';
    import FilesPane from './lib/FilesPane.svelte';
    import LegalGate from './lib/LegalGate.svelte';
    import ModelConfig from './lib/ModelConfig.svelte';
    import Sidebar from './lib/Sidebar.svelte';
    import { versionCheck } from './lib/versionCheck.svelte';

    onMount(() => {
        appLifecycle.start().catch((err) => {
            reportAppError(
                'app start failed',
                "Couldn't start AirmailAI. Refresh to try again",
                err
            );
        });
        const onAssetError = () => versionCheck.reportAssetLoadFailure();
        window.addEventListener('vite:preloadError', onAssetError);
        return () =>
            window.removeEventListener('vite:preloadError', onAssetError);
    });
</script>

{#if appMode.extensionPrompt}
    <ExtensionPrompt
        variant={appMode.extensionPrompt}
        onlookaround={() => appLifecycle.enterDemoMode()}
    />
{/if}

{#if appLifecycle.showLegalGate}
    <LegalGate onagree={() => appLifecycle.handleLegalAgree()} />
{/if}

<div class="app-root">
    <div class="app">
        <Sidebar />
        <div class="workspace">
            <div class="chat-view" inert={appLifecycle.view === 'files'}>
                <ChatPanel />
                <ModelConfig />
            </div>
            {#if appLifecycle.view === 'files'}
                <div class="files-view">
                    <FilesPane />
                </div>
            {/if}
        </div>
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
    .workspace {
        position: relative;
        display: flex;
        flex: 1;
        min-width: 0;
        min-height: 0;
    }
    .chat-view {
        display: flex;
        flex: 1;
        min-width: 0;
        min-height: 0;
    }
    .files-view {
        position: absolute;
        inset: 0;
        z-index: 30;
        display: flex;
    }
</style>
