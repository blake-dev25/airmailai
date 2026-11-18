<script lang="ts">
    import { AsyncResource } from '../asyncResource.svelte';
    import MarkdownMessage from '../MarkdownMessage.svelte';

    const changelog = new AsyncResource<string>();

    export function open() {
        if (changelog.state.status === 'idle') changelog.load(fetchChangelog);
    }

    async function fetchChangelog(): Promise<string> {
        const res = await fetch('/changelog.md');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
    }
</script>

{#if changelog.state.status === 'error'}
    <p class="text-sm text-accent-fg m-0 py-1">
        Couldn't load the changelog: {changelog.state.message}
    </p>
{:else if changelog.state.status === 'ready'}
    <MarkdownMessage content={changelog.state.value} />
{:else}
    <p class="text-sm text-fg m-0 py-1">Loading...</p>
{/if}
