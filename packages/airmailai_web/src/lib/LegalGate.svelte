<script lang="ts">
    import Icon from './Icon.svelte';

    let { onagree }: { onagree: () => void } = $props();
</script>

<div
    class="fixed inset-0 z-49 bg-black/50 backdrop-blur-[2px]"
    aria-hidden="true"
></div>

<div
    class="fixed top-1/2 left-1/2 z-50 flex w-[min(440px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-3 rounded-xl border border-border bg-canvas p-7 text-center shadow-[0_8px_40px_oklch(0%_0_0/25%)]"
    role="dialog"
    aria-label="Terms and Privacy"
    aria-modal="true"
>
    <h2 class="m-0 text-base font-semibold text-fg">Terms &amp; Privacy</h2>

    <p class="m-0 text-sm leading-normal text-fg-muted">
        By clicking <strong class="text-fg">Agree &amp; continue</strong>, you
        agree to our
        <a
            href="/legal/terms.md"
            target="_blank"
            rel="noopener"
            class="inline-flex items-center gap-0.5 text-accent-fg no-underline hover:underline"
            >Terms of Service<Icon name="external-link" /></a
        >
        and acknowledge our
        <a
            href="/legal/privacy.md"
            target="_blank"
            rel="noopener"
            class="inline-flex items-center gap-0.5 text-accent-fg no-underline hover:underline"
            >Privacy Policy<Icon name="external-link" /></a
        >.
    </p>

    <button
        type="button"
        class="mt-2 cursor-pointer rounded-md border-0 bg-accent-bg px-6 py-2 text-sm font-medium text-on-accent-bg transition-colors hover:bg-accent-bg-hover hover:text-on-accent-bg-hover"
        onclick={onagree}>Agree &amp; continue</button
    >
</div>
