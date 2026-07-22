<script lang="ts">
    import Icon from './Icon.svelte';

    type Variant = 'no-extension' | 'unsupported-browser' | 'mobile';

    let {
        variant,
        onlookaround,
    }: { variant: Variant; onlookaround: () => void } = $props();

    const titles: Record<Variant, string> = {
        'no-extension': 'Extension required',
        'unsupported-browser': 'Browser not supported',
        mobile: 'Desktop only',
    };
</script>

<div
    class="fixed inset-0 z-49 bg-black/50 backdrop-blur-[2px]"
    aria-hidden="true"
></div>

<div
    class="fixed top-1/2 left-1/2 z-50 flex w-[min(400px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-3 rounded-xl border border-border bg-canvas p-7 text-center shadow-[0_8px_40px_oklch(0%_0_0/25%)]"
    role="dialog"
    aria-label={titles[variant]}
    aria-modal="true"
>
    <h2 class="m-0 text-base font-semibold text-fg">{titles[variant]}</h2>

    {#if variant === 'no-extension'}
        <p class="m-0 text-sm leading-normal text-fg-muted">
            AirmailAI needs the browser extension to store your API keys and
            send requests. Install it, then reload this page.
        </p>
        <button
            type="button"
            class="mt-2 cursor-pointer rounded-md border-0 bg-accent-bg px-6 py-2 text-sm font-medium text-on-accent-bg transition-colors hover:bg-accent-bg-hover hover:text-on-accent-bg-hover"
            onclick={() => window.location.reload()}>Reload</button
        >
        <button
            type="button"
            class="mt-2 cursor-pointer rounded-md border-0 bg-accent-bg px-6 py-2 text-sm font-medium text-on-accent-bg transition-colors hover:bg-accent-bg-hover hover:text-on-accent-bg-hover"
            onclick={onlookaround}>Try the Demo</button
        >
        <p class="-mt-1 text-xs text-fg-muted">
            (chats/settings will not be saved in demo mode)
        </p>
    {:else if variant === 'unsupported-browser'}
        <p class="m-0 text-sm leading-normal text-fg-muted">
            AirmailAI requires a Chromium browser (Chrome, Edge, Brave, etc)
            with the AirmailAI extension installed. See our <a
                href="/faq"
                class="inline-flex items-center gap-0.5 text-accent-fg no-underline hover:underline"
                >FAQ<Icon name="external-link" /></a
            >
        </p>
        <button
            type="button"
            class="mt-2 cursor-pointer rounded-md border-0 bg-accent-bg px-6 py-2 text-sm font-medium text-on-accent-bg transition-colors hover:bg-accent-bg-hover hover:text-on-accent-bg-hover"
            onclick={onlookaround}>Try the Demo</button
        >
        <p class="-mt-1 text-xs text-fg-muted">
            (chats/settings will not be saved in demo mode)
        </p>
    {:else}
        <p class="m-0 text-sm leading-normal text-fg-muted">
            AirmailAI requires a desktop Chromium-based browser and the
            AirmailAI extension, so it isn't available on mobile. Please visit
            on desktop.
        </p>
    {/if}
</div>
