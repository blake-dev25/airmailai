<script lang="ts">
    import type { LocalFileInfo, ProviderFileInfo } from '@airmailai/shared';
    import { onMount } from 'svelte';
    import { appLifecycle } from './appLifecycle.svelte';
    import { chatStore } from './chatStore.svelte';
    import { PROVIDERS } from './constants';
    import { reportAppError } from './errorStore.svelte';
    import {
        deleteStoredFile,
        getFileBlob,
        listLocalFiles,
        listProviderFiles,
    } from './extension';
    import { formatFileSize, triggerBlobDownload } from './files';
    import Icon from './Icon.svelte';
    import { providersStore } from './providersStore.svelte';

    const FILES_API_PROVIDERS = new Set(['anthropic', 'google', 'openai']);
    const GB = 1024 ** 3;
    const PROVIDER_STORAGE_MAX_BYTES: Record<string, number> = {
        anthropic: 500 * GB,
        openai: 100 * GB,
        google: 20 * GB,
    };
    const PROVIDER_STORAGE_INFO: Record<string, string> = {
        openai: "The first 1GB of storage is free; OpenAI bills storage beyond that per GB per day. See OpenAI's pricing.",
        google: 'Files are deleted after 48 hours. Free plans cap files at 2GB each (paid plans 20GB).',
    };

    const rowBtnClass =
        'flex items-center justify-center w-6 h-6 p-0 bg-transparent border-0 text-current opacity-50 cursor-pointer shrink-0 transition-opacity duration-150 hover:opacity-100 disabled:opacity-30 disabled:cursor-default';

    let localFiles = $state<LocalFileInfo[] | null>(null);
    let localError = $state(false);
    let keysChecked = $state(false);
    let providerFiles = $state<Record<string, ProviderFileInfo[] | null>>({});
    let providerError = $state<Record<string, boolean>>({});
    let busyKey = $state<string | null>(null);

    function sumBytes(files: { sizeBytes: number }[]): number {
        return files.reduce((total, f) => total + f.sizeBytes, 0);
    }

    function formatDate(ms: number): string {
        if (!ms) return '-';
        return new Date(ms).toLocaleString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
        });
    }

    async function loadLocal() {
        localFiles = null;
        localError = false;
        try {
            localFiles = await listLocalFiles();
        } catch (err) {
            localError = true;
            localFiles = [];
            reportAppError(
                'listLocalFiles failed',
                "Couldn't load your files",
                err
            );
        }
    }

    async function loadProviders() {
        try {
            await providersStore.refreshSavedKeys();
        } catch (err) {
            reportAppError(
                'checkApiKeys failed',
                "Couldn't read saved API keys",
                err
            );
            return;
        } finally {
            keysChecked = true;
        }
        for (const provider of PROVIDERS) {
            if (!FILES_API_PROVIDERS.has(provider.id)) continue;
            if (!providersStore.savedKeys?.[provider.id]) continue;
            void loadProviderFiles(provider.id);
        }
    }

    async function loadProviderFiles(providerId: string) {
        providerError[providerId] = false;
        providerFiles[providerId] = null;
        try {
            providerFiles[providerId] = await listProviderFiles(providerId);
        } catch (err) {
            providerError[providerId] = true;
            providerFiles[providerId] = [];
            reportAppError(
                `listProviderFiles failed (provider=${providerId})`,
                `Couldn't load ${providerId} files`,
                err
            );
        }
    }

    async function downloadLocal(file: LocalFileInfo) {
        try {
            const blob = await getFileBlob(file.hash);
            if (!blob) {
                reportAppError(
                    `local file blob missing (hash=${file.hash})`,
                    `Couldn't download ${file.filename}`,
                    new Error('file not found in storage')
                );
                return;
            }
            triggerBlobDownload(file.filename, blob);
        } catch (err) {
            reportAppError(
                `local file download failed (hash=${file.hash})`,
                `Couldn't download ${file.filename}`,
                err
            );
        }
    }

    async function deleteLocal(file: LocalFileInfo) {
        if (busyKey) return;
        busyKey = file.hash;
        try {
            const chatIds = await deleteStoredFile({
                kind: 'local',
                hash: file.hash,
            });
            localFiles = (localFiles ?? []).filter((f) => f.hash !== file.hash);
            await chatStore.refreshLoadedChats(chatIds);
        } catch (err) {
            reportAppError(
                `local file delete failed (hash=${file.hash})`,
                `Couldn't delete ${file.filename}`,
                err
            );
        } finally {
            busyKey = null;
        }
    }

    async function downloadProvider(file: ProviderFileInfo) {
        try {
            if (!file.hash) {
                throw new Error('file has no local copy');
            }
            const blob = await getFileBlob(file.hash);
            if (!blob) {
                throw new Error('file not found in local storage');
            }
            triggerBlobDownload(file.filename, blob);
        } catch (err) {
            reportAppError(
                `provider file download failed (fileId=${file.fileId})`,
                `Couldn't download ${file.filename}`,
                err
            );
        }
    }

    async function deleteProvider(providerId: string, file: ProviderFileInfo) {
        if (busyKey) return;
        busyKey = file.fileId;
        try {
            const chatIds = await deleteStoredFile({
                kind: 'provider',
                providerId,
                fileId: file.fileId,
            });
            providerFiles[providerId] = (
                providerFiles[providerId] ?? []
            ).filter((f) => f.fileId !== file.fileId);
            await chatStore.refreshLoadedChats(chatIds);
        } catch (err) {
            reportAppError(
                `provider file delete failed (fileId=${file.fileId})`,
                `Couldn't delete ${file.filename}`,
                err
            );
        } finally {
            busyKey = null;
        }
    }

    async function deleteAllProvider(providerId: string, providerName: string) {
        const files = providerFiles[providerId] ?? [];
        if (busyKey || !files.length) return;
        const label = files.length === 1 ? 'file' : 'files';
        if (
            !confirm(
                `Delete all ${files.length} ${label} stored with ${providerName}? Cannot be undone.`
            )
        )
            return;
        busyKey = `all:${providerId}`;
        const chatIds = new Set<string>();
        let failed = false;
        try {
            for (const file of [...files]) {
                try {
                    const ids = await deleteStoredFile({
                        kind: 'provider',
                        providerId,
                        fileId: file.fileId,
                    });
                    for (const id of ids) chatIds.add(id);
                    providerFiles[providerId] = (
                        providerFiles[providerId] ?? []
                    ).filter((f) => f.fileId !== file.fileId);
                } catch (err) {
                    failed = true;
                    reportAppError(
                        `provider file delete failed (fileId=${file.fileId})`,
                        `Couldn't delete ${file.filename}`,
                        err
                    );
                    break;
                }
            }
        } finally {
            busyKey = null;
        }
        await chatStore.refreshLoadedChats([...chatIds]);
        if (failed) void loadProviderFiles(providerId);
    }

    onMount(() => {
        loadLocal();
        loadProviders();
    });
</script>

<main
    class="files-pane relative flex-1 min-w-0 flex flex-col bg-canvas overflow-hidden"
>
    <button
        type="button"
        class="absolute top-4 right-4 z-10 flex items-center justify-center w-7 h-7 p-0 bg-transparent border-0 rounded-md text-fg-muted cursor-pointer transition-[background-color,color] duration-100 hover:bg-surface-raised hover:text-fg"
        aria-label="Close files"
        onclick={() => (appLifecycle.view = 'chat')}
    >
        <Icon name="close" size={16} />
    </button>

    <div class="flex-1 min-h-0 overflow-y-auto">
        <div class="w-full max-w-200 mx-auto px-6 py-8 flex flex-col gap-7">
            <div
                class="flex items-center gap-1.5 self-start bg-surface-raised rounded-md px-3 py-2"
            >
                <h1 class="text-xl font-semibold text-fg">Files</h1>
                {@render info(
                    'Deleting a file under "On this device" removes it from this device only - provider copies keep working in chats until you delete them too. Files that are no longer available anywhere stay visible in chats, marked as unavailable.'
                )}
            </div>

            <section class="flex flex-col gap-1.5">
                <div class="flex items-center gap-1.5">
                    <h2 class="text-base font-semibold text-fg">
                        On this device
                    </h2>
                    {@render info('IndexedDB storage')}
                </div>
                {#if localFiles === null}
                    {@render loading()}
                {:else if localError}
                    <p class="text-sm text-fg-muted">Couldn't load files.</p>
                {:else if localFiles.length === 0}
                    <p class="text-sm text-fg-muted">No files</p>
                {:else}
                    {#each localFiles as file (file.hash)}
                        {@render fileRow({
                            filename: file.filename,
                            createdAt: file.createdAt,
                            sizeBytes: file.sizeBytes,
                            rowKey: file.hash,
                            download: () => downloadLocal(file),
                            remove: () => deleteLocal(file),
                        })}
                    {/each}
                {/if}
            </section>

            {#each PROVIDERS as provider (provider.id)}
                {@const files = providerFiles[provider.id] ?? []}
                {@const keySaved = !!providersStore.savedKeys?.[provider.id]}
                {@const ready =
                    FILES_API_PROVIDERS.has(provider.id) &&
                    keysChecked &&
                    keySaved &&
                    providerFiles[provider.id] != null &&
                    !providerError[provider.id]}
                {@const max = PROVIDER_STORAGE_MAX_BYTES[provider.id]}
                <section class="flex flex-col gap-1.5">
                    <div class="flex items-center justify-between gap-2">
                        <div class="flex items-center gap-1.5">
                            <h2 class="text-base font-semibold text-fg">
                                {provider.name}
                            </h2>
                            {#if PROVIDER_STORAGE_INFO[provider.id]}
                                {@render info(
                                    PROVIDER_STORAGE_INFO[provider.id]
                                )}
                            {/if}
                        </div>
                        <div class="flex items-center gap-3">
                            {#if ready && max !== undefined}
                                <span
                                    class="text-xs text-fg-muted whitespace-nowrap"
                                >
                                    Storage used: {formatFileSize(
                                        sumBytes(files)
                                    )} /
                                    {formatFileSize(max)}
                                </span>
                            {/if}
                            {#if ready && files.length > 0}
                                <button
                                    type="button"
                                    class="flex items-center px-2 py-1 bg-transparent border border-border rounded-md text-xs text-fg-muted whitespace-nowrap cursor-pointer transition-[color,border-color] duration-100 enabled:hover:text-accent-fg enabled:hover:border-accent-fg disabled:opacity-40 disabled:cursor-not-allowed"
                                    disabled={busyKey !== null}
                                    onclick={() =>
                                        deleteAllProvider(
                                            provider.id,
                                            provider.name
                                        )}
                                >
                                    {#if busyKey === `all:${provider.id}`}
                                        <Icon name="spinner" size={13} />
                                    {:else}
                                        Delete all
                                    {/if}
                                </button>
                            {/if}
                        </div>
                    </div>
                    {#if !FILES_API_PROVIDERS.has(provider.id)}
                        <p class="text-sm text-fg-muted">No files API</p>
                    {:else if !keysChecked}
                        {@render loading()}
                    {:else if !keySaved}
                        <p class="text-sm text-fg-muted">No API key</p>
                    {:else if providerFiles[provider.id] == null}
                        {@render loading()}
                    {:else if providerError[provider.id]}
                        <p class="text-sm text-fg-muted">
                            Couldn't load files.
                        </p>
                    {:else if files.length === 0}
                        <p class="text-sm text-fg-muted">No files</p>
                    {:else}
                        {#each files as file (file.fileId)}
                            {@render fileRow({
                                filename: file.filename,
                                createdAt: file.createdAt,
                                sizeBytes: file.sizeBytes,
                                rowKey: file.fileId,
                                ...(file.hash
                                    ? {
                                          download: () =>
                                              downloadProvider(file),
                                      }
                                    : {}),
                                remove: () => deleteProvider(provider.id, file),
                            })}
                        {/each}
                    {/if}
                </section>
            {/each}
        </div>
    </div>
</main>

{#snippet loading()}
    <div class="flex items-center gap-2 text-sm text-fg-muted">
        <Icon name="spinner" size={14} /> Loading...
    </div>
{/snippet}

{#snippet fileRow(opts: {
    filename: string;
    createdAt: number;
    sizeBytes: number;
    rowKey: string;
    download?: () => void;
    remove: () => void;
})}
    <div
        class="flex items-center gap-3 -mx-2 px-2 py-1.5 rounded-md transition-[background-color] duration-100 hover:bg-surface-raised"
    >
        <Icon name="file" size={15} class="text-fg-muted shrink-0" />
        <span class="flex-1 min-w-0 text-sm text-fg break-all">
            {opts.filename}
        </span>
        <span class="shrink-0 text-xs text-fg-muted whitespace-nowrap">
            {formatDate(opts.createdAt)} &middot; {formatFileSize(
                opts.sizeBytes
            )}
        </span>
        <div class="flex items-center gap-1 shrink-0">
            {#if opts.download}
                <button
                    type="button"
                    class={rowBtnClass}
                    title="Download {opts.filename}"
                    aria-label="Download {opts.filename}"
                    disabled={busyKey !== null}
                    onclick={opts.download}
                >
                    <Icon name="download" size={15} />
                </button>
            {/if}
            {#if busyKey === opts.rowKey}
                <span
                    class="flex items-center justify-center w-6 h-6 shrink-0 opacity-50"
                >
                    <Icon name="spinner" size={15} />
                </span>
            {:else}
                <button
                    type="button"
                    class={rowBtnClass}
                    title="Delete {opts.filename}"
                    aria-label="Delete {opts.filename}"
                    disabled={busyKey !== null}
                    onclick={opts.remove}
                >
                    <Icon name="trash" size={15} />
                </button>
            {/if}
        </div>
    </div>
{/snippet}

{#snippet info(text: string)}
    <span
        class="info-icon relative inline-flex items-center text-fg-muted opacity-60 cursor-default hover:opacity-100"
        aria-label="More info"
    >
        <Icon name="info" />
        <span
            class="info-tooltip hidden absolute top-[calc(100%+6px)] left-1/2 -translate-x-1/2 w-64 px-2.5 py-2 bg-surface-raised border border-border rounded-[7px] text-xs leading-normal text-fg font-normal text-left shadow-[0_4px_16px_oklch(0%_0_0/15%)] pointer-events-none z-10"
            >{text}</span
        >
    </span>
{/snippet}

<style>
    .info-icon:hover .info-tooltip {
        display: block;
    }
</style>
