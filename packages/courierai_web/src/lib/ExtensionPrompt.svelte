<div class="backdrop" aria-hidden="true"></div>

<div
    class="popover"
    role="dialog"
    aria-label="Extension required"
    aria-modal="true"
>
    <div class="icon">
        <svg
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            role="img"
            aria-hidden="true"
        >
            <path
                d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2v-4M9 21H5a2 2 0 0 1-2-2v-4m0 0h18"
                stroke="currentColor"
                stroke-width="1.75"
                stroke-linecap="round"
                stroke-linejoin="round"
            />
        </svg>
    </div>
    <h2>Extension required</h2>
    <p>
        CourierAI needs the browser extension to store your API keys and send
        requests. Install it, then reload this page.
    </p>
    <button type="button" onclick={() => window.location.reload()}
        >Reload</button
    >
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
        padding: 32px 28px;
        text-align: center;
    }

    .icon {
        color: var(--color-accent);
        margin-bottom: 4px;
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

    button {
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

    button:hover {
        background-color: var(--color-accent-hover);
    }
</style>
