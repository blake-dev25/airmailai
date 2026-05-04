<script lang="ts">
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

<div class="backdrop" aria-hidden="true"></div>

<div
    class="popover"
    role="dialog"
    aria-label={titles[variant]}
    aria-modal="true"
>
    <h2>{titles[variant]}</h2>

    {#if variant === 'no-extension'}
        <p>
            CourierAI needs the browser extension to store your API keys and
            send requests. Install it, then reload this page.
        </p>
        <button
            type="button"
            class="primary"
            onclick={() => window.location.reload()}>Reload</button
        >
        <button type="button" class="primary" onclick={onlookaround}
            >Let me look around first</button
        >
        <p class="caption">(text/settings will not be saved)</p>
    {:else if variant === 'unsupported-browser'}
        <p>
            CourierAI requires a Chromium browser (Chrome, Edge, Brave, etc)
            with the CourierAI extension installed. See our <a
                href="/faq"
                class="inline-link">FAQ ↗</a
            >
        </p>
        <button type="button" class="primary" onclick={onlookaround}
            >Let me look around first</button
        >
        <p class="caption">(text/settings will not be saved)</p>
    {:else}
        <p>
            CourierAI requires a desktop browser extension, so it isn't
            available on mobile. Please visit on desktop.
        </p>
    {/if}
</div>

<style>
    .backdrop {
        position: fixed;
        inset: 0;
        z-index: 49;
        background-color: oklch(0% 0 0 / 50%);
        backdrop-filter: blur(2px);
    }

    .popover {
        position: fixed;
        top: 50%;
        left: 50%;
        translate: -50% -50%;
        width: min(400px, calc(100vw - 48px));
        z-index: 50;
        background-color: var(--color-bg);
        border: 1px solid var(--color-border);
        border-radius: 12px;
        box-shadow: 0 8px 40px oklch(0% 0 0 / 25%);
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
        padding: 28px;
        text-align: center;
    }

    h2 {
        margin: 0;
        font-size: 1rem;
        font-weight: 600;
        color: var(--color-text);
    }

    p {
        margin: 0;
        font-size: 0.8125rem;
        color: var(--color-text-muted);
        line-height: 1.5;
    }

    .inline-link {
        color: var(--color-accent);
        text-decoration: none;
    }

    .inline-link:hover {
        text-decoration: underline;
    }

    .primary {
        margin-top: 8px;
        padding: 8px 24px;
        background-color: var(--color-accent);
        color: var(--color-bg);
        border: none;
        border-radius: 6px;
        font-size: 0.875rem;
        font-weight: 500;
        cursor: pointer;
        transition: background-color 0.15s;
    }

    .primary:hover {
        background-color: var(--color-accent-hover);
    }

    .caption {
        margin-top: -4px;
        font-size: 0.75rem;
        color: var(--color-text-muted);
    }
</style>
