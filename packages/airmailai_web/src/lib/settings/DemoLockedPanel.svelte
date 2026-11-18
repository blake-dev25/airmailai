<script lang="ts">
    import type { Snippet } from 'svelte';
    import { appMode } from '../appMode.svelte';
    import { EXTENSION_STORE_URL } from '../constants';
    import Icon from '../Icon.svelte';

    let { children }: { children: Snippet } = $props();

    const demo = appMode.isDemo;
</script>

{#if demo}
    <p class="m-0 text-sm text-fg">
        Faded settings require the <a
            href={EXTENSION_STORE_URL}
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex items-center gap-0.5 p-0 bg-transparent border-0 font-sans text-sm text-accent-fg no-underline cursor-pointer hover:underline"
            >AirmailAI extension<Icon name="external-link" /></a
        >
    </p>
{/if}
<div class={['flex flex-col gap-5', demo && 'opacity-40']} inert={demo}>
    {@render children()}
</div>
