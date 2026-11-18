<script lang="ts">
    import type { AttachmentUploads } from '../attachmentUploads.svelte';
    import { formatFileSize } from '../files';
    import Icon from '../Icon.svelte';

    let { uploads }: { uploads: AttachmentUploads } = $props();
</script>

{#if uploads.fileErrors.length}
    <div class="flex flex-col gap-1 px-4 pt-2">
        {#each uploads.fileErrors as error (error.id)}
            <div
                class="flex items-center gap-2 text-xs text-accent-fg"
                role="alert"
            >
                <span class="min-w-0 flex-1 wrap-break-word"
                    >{error.message}</span
                >
                <button
                    type="button"
                    class="flex items-center justify-center w-4 h-4 bg-transparent border-0 p-0 text-accent-fg opacity-60 cursor-pointer shrink-0 transition-opacity duration-150 hover:opacity-100"
                    onclick={() => uploads.dismissFileError(error.id)}
                    aria-label="Dismiss file error"
                >
                    <Icon name="close" />
                </button>
            </div>
        {/each}
    </div>
{/if}
{#if uploads.pending.length || uploads.activeProcessing.length}
    <div class="flex items-start justify-between gap-3 px-4 pt-2">
        <div class="flex flex-wrap gap-1 min-w-0">
            {#each uploads.activeProcessing.toReversed() as att (att.id)}
                <div
                    class="relative overflow-hidden inline-flex items-center gap-1.5 pl-2.5 pr-2 py-1.25 bg-surface-sunken border border-border rounded-lg text-xs text-fg max-w-60"
                >
                    <span
                        class="absolute top-0 left-0 h-0.5 bg-accent-3-bg transition-[width] duration-150"
                        style="width: {att.progress}%"
                    ></span>
                    <Icon name="spinner" />
                    <span
                        class="overflow-hidden text-ellipsis whitespace-nowrap max-w-45"
                        >{att.name}</span
                    >
                </div>
            {/each}
            {#each uploads.pending.toReversed() as att (att.hash)}
                <div
                    class="inline-flex items-center gap-1.5 pl-2.5 pr-2 py-1.25 bg-surface-sunken border border-border rounded-lg text-xs text-fg max-w-60"
                >
                    <Icon name="file" />
                    <span
                        class="overflow-hidden text-ellipsis whitespace-nowrap max-w-45"
                        >{att.name}</span
                    >
                    <button
                        type="button"
                        class="flex items-center justify-center w-4 h-4 bg-transparent border-0 p-0 text-fg opacity-50 cursor-pointer shrink-0 transition-opacity duration-150 hover:opacity-100"
                        onclick={() => uploads.removeDraft(att.hash)}
                        aria-label="Remove attachment"
                    >
                        <Icon name="close" />
                    </button>
                </div>
            {/each}
        </div>
        <div
            class="shrink-0 pt-1 text-[0.6875rem] leading-none text-fg-muted tabular-nums"
        >
            {formatFileSize(uploads.totalBytes)} / {formatFileSize(
                uploads.policy.maxRequestBytes
            )}
        </div>
    </div>
{/if}
