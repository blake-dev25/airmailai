<script lang="ts">
    import { chatStore } from '../chatStore.svelte';
    import { GITHUB_ISSUES_URL } from '../constants';
    import { errorStore } from '../errorStore.svelte';
    import Icon from '../Icon.svelte';
    import { versionCheck } from '../versionCheck.svelte';
</script>

{#if versionCheck.notice}
    <div
        class="shrink-0 flex items-center gap-3 px-4 py-2 text-sm text-fg border-t border-border bg-canvas"
        role="status"
    >
        <span class="min-w-0 flex-1 wrap-break-word"
            >{versionCheck.notice.message}</span
        >
        {#if versionCheck.notice.refresh}
            <button
                type="button"
                class="shrink-0 px-2.5 py-1 text-xs bg-surface-sunken border border-border rounded-md text-fg cursor-pointer transition-[background-color] duration-150 hover:bg-border"
                onclick={() => location.reload()}
            >
                Refresh
            </button>
        {/if}
        <button
            type="button"
            class="shrink-0 flex items-center justify-center w-6 h-6 p-0 bg-transparent border-0 rounded-md text-fg cursor-pointer opacity-70 transition-[opacity,background-color] duration-150 hover:opacity-100 hover:bg-surface-sunken"
            onclick={() => versionCheck.dismiss()}
            aria-label="Dismiss update notice"
        >
            <Icon name="close" />
        </button>
    </div>
{/if}

{#if errorStore.appWarning?.kind === 'model-unavailable'}
    <div
        class="shrink-0 flex items-center gap-3 px-4 py-2 text-sm text-fg border-t border-border bg-canvas"
        role="status"
        data-testid="model-unavailable-warning"
    >
        <span class="min-w-0 flex-1 wrap-break-word"
            >Warning: previously selected model '{errorStore.appWarning
                .modelId}' is not available. This is usually due to the model
            being retired by the API provider. Selected model has been switched
            to the current provider default. If you believe this is incorrect,
            please open an issue on
            <a
                href={GITHUB_ISSUES_URL}
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex items-center gap-0.5 text-accent-fg no-underline hover:underline"
                >GitHub<Icon name="external-link" /></a
            >.</span
        >
        <button
            type="button"
            class="shrink-0 flex items-center justify-center w-6 h-6 p-0 bg-transparent border-0 rounded-md text-fg cursor-pointer opacity-70 transition-[opacity,background-color] duration-150 hover:opacity-100 hover:bg-surface-sunken"
            onclick={() => errorStore.clearAppWarning()}
            aria-label="Dismiss warning"
        >
            <Icon name="close" />
        </button>
    </div>
{/if}

{#if errorStore.appError}
    <div
        class="shrink-0 flex items-center gap-3 px-4 py-2 text-sm text-accent-fg border-t border-border bg-canvas"
        role="alert"
    >
        <span class="min-w-0 flex-1 wrap-break-word">{errorStore.appError}</span
        >
        <button
            type="button"
            class="shrink-0 flex items-center justify-center w-6 h-6 p-0 bg-transparent border-0 rounded-md text-accent-fg cursor-pointer opacity-70 transition-[opacity,background-color] duration-150 hover:opacity-100 hover:bg-surface-sunken"
            onclick={() => errorStore.clearAppError()}
            aria-label="Dismiss error"
        >
            <Icon name="close" />
        </button>
    </div>
{/if}

{#if chatStore.activeStreamError}
    <div
        class="shrink-0 flex items-center gap-3 px-4 py-2 text-sm text-accent-fg border-t border-border bg-canvas"
        role="alert"
    >
        <span class="min-w-0 flex-1 wrap-break-word"
            >{chatStore.activeStreamError}</span
        >
        <button
            type="button"
            class="shrink-0 flex items-center justify-center w-6 h-6 p-0 bg-transparent border-0 rounded-md text-accent-fg cursor-pointer opacity-70 transition-[opacity,background-color] duration-150 hover:opacity-100 hover:bg-surface-sunken"
            onclick={() => chatStore.clearActiveChatError()}
            aria-label="Dismiss error"
        >
            <Icon name="close" />
        </button>
    </div>
{/if}
