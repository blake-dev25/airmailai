<script lang="ts">
    import type { StorageUsage } from '@airmailai/shared';
    import { appMode } from '../appMode.svelte';
    import { AsyncResource } from '../asyncResource.svelte';
    import { exportAllChats } from '../chatExport';
    import { chatStore } from '../chatStore.svelte';
    import { reportAppError } from '../errorStore.svelte';
    import { formatFileSize } from '../files';
    import {
        clearAllChats,
        clearAllStorage,
        getStorageUsage,
        waitForExtension,
    } from '../extension';
    import Icon from '../Icon.svelte';
    import { providersStore } from '../providersStore.svelte';
    import DemoLockedPanel from './DemoLockedPanel.svelte';

    const storage = new AsyncResource<StorageUsage>();
    let storageUsage = $derived(storage.value);
    let storageLoading = $derived(storage.state.status === 'loading');
    let storageBusy = $state(false);
    let transferBusy = $state(false);
    let importInput = $state<HTMLInputElement | undefined>(undefined);

    export function open() {
        if (appMode.isDemo) return;
        if (storage.state.status === 'idle') refreshStorageUsage();
    }

    async function refreshStorageUsage() {
        await storage.load(
            async () => {
                await waitForExtension();
                return getStorageUsage();
            },
            {
                context: 'getStorageUsage failed',
                userMessage: "Couldn't read storage usage",
            }
        );
    }

    async function handleExportAll() {
        transferBusy = true;
        try {
            await exportAllChats();
        } finally {
            transferBusy = false;
        }
    }

    async function handleImportChats(e: Event) {
        const input = e.currentTarget as HTMLInputElement;
        const files = Array.from(input.files ?? []);
        input.value = '';
        transferBusy = true;
        try {
            for (const file of files) {
                await chatStore.importChatFile(file);
            }
            await refreshStorageUsage();
        } finally {
            transferBusy = false;
        }
    }

    async function handleClearChats() {
        if (
            !confirm(
                'Delete all chat history? This also deletes locally stored files. Files on provider servers are not affected. Cannot be undone.'
            )
        )
            return;
        storageBusy = true;
        try {
            await clearAllChats();
            chatStore.resetLocal();
            await refreshStorageUsage();
        } catch (err) {
            reportAppError(
                'clearAllChats failed',
                "Couldn't delete chat history",
                err
            );
        } finally {
            storageBusy = false;
        }
    }

    async function handleClearAll() {
        if (
            !confirm(
                'Delete all local storage? This removes your API keys, settings, chat history, and locally stored files. Files on provider servers are not affected. Cannot be undone.'
            )
        )
            return;
        storageBusy = true;
        try {
            await clearAllStorage();
            localStorage.removeItem('airmailai-theme');
            localStorage.removeItem('airmailai-show-branding');
            localStorage.removeItem('airmailai-message-font');
            chatStore.resetLocal();
            providersStore.markAllKeysCleared();
            await refreshStorageUsage();
        } catch (err) {
            reportAppError(
                'clearAllStorage failed',
                "Couldn't delete storage",
                err
            );
        } finally {
            storageBusy = false;
        }
    }

    let storageTotal = $derived(
        storageUsage
            ? storageUsage.localSettingsBytes +
                  storageUsage.openRouterCacheBytes +
                  storageUsage.syncSettingsBytes +
                  storageUsage.chatHistoryBytes +
                  storageUsage.filesBytes
            : 0
    );

    let storageRows = $derived<
        { label: string; bytes: number; approximate?: boolean }[]
    >([
        {
            label: 'Device Settings & API Keys',
            bytes: storageUsage?.localSettingsBytes ?? 0,
        },
        {
            label: 'OpenRouter Model Cache',
            bytes: storageUsage?.openRouterCacheBytes ?? 0,
        },
        {
            label: 'Synced Settings',
            bytes: storageUsage?.syncSettingsBytes ?? 0,
        },
        {
            label: 'Chat History',
            bytes: storageUsage?.chatHistoryBytes ?? 0,
            approximate: true,
        },
        {
            label: 'Files',
            bytes: storageUsage?.filesBytes ?? 0,
        },
    ]);

    const actionButtonClass =
        'flex-1 flex items-center justify-center gap-2 px-3 py-2 border border-accent-fg rounded-md text-sm font-medium cursor-pointer whitespace-nowrap transition-[background-color,color,opacity] duration-150 bg-transparent text-accent-fg enabled:hover:bg-accent-bg enabled:hover:text-on-accent-bg disabled:opacity-[0.35] disabled:cursor-not-allowed';
</script>

<DemoLockedPanel>
    <div class="flex flex-col gap-2.5">
        {#each storageRows as row (row.label)}
            <div
                class="flex items-center justify-between py-1.5 border-b border-border"
            >
                <span class="text-sm text-fg">{row.label}</span>
                <span class="text-sm tabular-nums text-fg-muted font-mono">
                    {storageUsage
                        ? `${row.approximate ? '~' : ''}${formatFileSize(row.bytes)}`
                        : '-'}
                </span>
            </div>
        {/each}
        <div class="flex items-center justify-between py-1.5">
            <span class="text-sm text-fg font-medium">Total</span>
            <span class="text-sm tabular-nums text-fg font-mono font-medium">
                {storageUsage ? `~${formatFileSize(storageTotal)}` : '-'}
            </span>
        </div>
        <p class="m-0 text-xs text-fg-muted">
            Sizes reflect storage on your device. Files uploaded with Provider
            File Storage also have copies on provider servers, which can be
            managed in the Files tab.
        </p>
    </div>
    <div class="flex flex-col gap-2">
        <div class="flex gap-2">
            <button
                type="button"
                class={actionButtonClass}
                disabled={transferBusy}
                onclick={handleExportAll}
            >
                <Icon name="download" />
                Export all chats
            </button>
            <button
                type="button"
                class={actionButtonClass}
                disabled={transferBusy}
                onclick={() => importInput?.click()}
            >
                <Icon name="upload" />
                Import chats
            </button>
            <input
                class="hidden"
                type="file"
                accept=".md,.json,.jsonl,.yaml,.yml"
                multiple
                bind:this={importInput}
                onchange={handleImportChats}
            />
        </div>
        <p class="m-0 text-xs text-fg-muted">
            Export downloads a readable YAML backup of all chats (uploaded files
            are not included). Import accepts AirmailAI backups, plus
            single-chat Markdown, LM Studio JSON, and SillyTavern JSONL files.
        </p>
    </div>
    <div class="flex gap-2">
        <button
            type="button"
            class={actionButtonClass}
            disabled={storageBusy || storageLoading}
            onclick={handleClearChats}
        >
            <Icon name="trash" />
            Delete chat history
        </button>
        <button
            type="button"
            class={actionButtonClass}
            disabled={storageBusy || storageLoading}
            onclick={handleClearAll}
        >
            <Icon name="trash" />
            Delete all local storage
        </button>
    </div>
</DemoLockedPanel>
