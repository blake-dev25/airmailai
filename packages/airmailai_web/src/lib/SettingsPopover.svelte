<script lang="ts">
    import type { StorageUsage } from '@airmailai/shared';
    import { appLifecycle } from './appLifecycle.svelte';
    import { chatStore } from './chatStore.svelte';
    import { PROVIDERS, THEMES } from './constants';
    import { formatErr, reportAppError } from './errorStore.svelte';
    import { formatFileSize } from './files';
    import {
        clearAllChats,
        clearAllStorage,
        clearApiKey,
        getOpenRouterRefreshStatus,
        getStorageUsage,
        saveApiKey,
        testApiKey,
        waitForExtension,
    } from './extension';
    import Icon from './Icon.svelte';
    import MarkdownMessage from './MarkdownMessage.svelte';
    import { providersStore } from './providersStore.svelte';
    import { settingsStore } from './settingsStore.svelte';

    let { onclose }: { onclose: () => void } = $props();

    const demo = chatStore.demoMode;

    let activeTab = $state<
        'keys' | 'ui' | 'tools' | 'storage' | 'advanced' | 'changelog'
    >(demo ? 'ui' : 'keys');

    const WEB_SEARCH_INFO =
        'Lets models search the internet using a provider server-side search tool. May have additional costs, see provider API documentation for details.';
    const WEB_FETCH_INFO =
        'Lets models fetch specific web pages using a provider server-side fetch tool. May have additional costs, see provider API documentation for details.';
    const CODE_EXECUTION_INFO =
        'Lets models execute code in a provider server-side sandbox environment. May have additional costs, see provider API documentation for details. ' +
        'Code runs in a container that persists temporarily on provider servers (OpenAI ~20 minutes idle, Anthropic ~30 days). Some providers do not offer a way to delete containers. ' +
        "Google runs code in a temporary sandbox with no persistent storage - nothing is stored on Google's servers to manage or delete.";
    const PROVIDER_FILE_STORAGE_INFO =
        'When turned on, stores uploaded files on provider servers. This can save tokens in multi-turn conversations. When turned off, files are sent and processed every turn, but are not stored on provider servers. See provider API documentation for details.';
    const SMOOTH_TEXT_INFO =
        'Changes how AI messages are displayed. Smooth animates text in at a steady pace; raw displays chunks exactly as they arrive.';
    const OPENROUTER_PDF_INFO =
        'Controls how PDFs are processed in OpenRouter chats. "Provider native only" sends the PDF to the model provider and nowhere else, but only works with models that support PDF input. The Cloudflare and Mistral options parse the PDF into text first, which lets any model read PDFs but routes the file contents through that third party. Mistral OCR bills per page to your OpenRouter account; Cloudflare parsing is free.';
    const FILE_UPLOADS_WARNING =
        "When file uploads are enabled, AirmailAI turns on Provider File Storage (PFS) and Code Execution (CE) by default. Any files uploaded through AirmailAI are stored on your device in IndexedDB; PFS also saves a copy on provider servers until you delete it, subject to each provider's retention policies. When combined with PFS, Code Execution enables Anthropic and OpenAI models to access, search, and process files directly in its sandbox container, which can reduce token usage. With Google, files are read fully into the model's context each time they are used (including by CE), so they do not reduce token usage and large files may not fit. When PFS is turned off, the full file content must be sent to the provider with every relevant message, which can increase token usage. You can manage stored files anytime from the Files tab in the sidebar. PFS and CE may add provider-side costs, see each provider's API documentation for pricing and retention details.";
    const OPENROUTER_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
    const OPENROUTER_REFRESH_COOLDOWN_TITLE =
        'Recently refreshed, please wait 5m to try again.';
    const DEMO_LOCKED_TITLE = 'Requires the AirmailAI extension';

    let storageUsage = $state<StorageUsage | null>(null);
    let storageLoading = $state(false);
    let storageBusy = $state(false);
    let transferBusy = $state(false);
    let importInput = $state<HTMLInputElement | undefined>(undefined);

    async function handleExportAll() {
        transferBusy = true;
        try {
            await chatStore.exportAllChats();
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

    async function refreshStorageUsage() {
        storageLoading = true;
        try {
            await waitForExtension();
            storageUsage = await getStorageUsage();
        } catch (err) {
            reportAppError(
                'getStorageUsage failed',
                "Couldn't read storage usage",
                err
            );
        } finally {
            storageLoading = false;
        }
    }

    function openStorageTab() {
        activeTab = 'storage';
        if (demo) return;
        if (storageUsage === null && !storageLoading) refreshStorageUsage();
    }

    let changelogMd = $state<string | null>(null);
    let changelogLoading = $state(false);
    let changelogError = $state<string | null>(null);

    async function loadChangelog() {
        changelogLoading = true;
        changelogError = null;
        try {
            const res = await fetch('/changelog.md');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            changelogMd = await res.text();
        } catch (err) {
            changelogError = `Couldn't load the changelog: ${formatErr(err)}`;
        } finally {
            changelogLoading = false;
        }
    }

    function openChangelogTab() {
        activeTab = 'changelog';
        if (changelogMd === null && !changelogLoading) loadChangelog();
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
            keyTests = {};
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

    let showPrevious = $derived(
        settingsStore.modelTier === 'previous' ||
            settingsStore.modelTier === 'legacy'
    );
    let showLegacy = $derived(settingsStore.modelTier === 'legacy');

    function togglePrevious(checked: boolean) {
        settingsStore.modelTier = checked ? 'previous' : 'latest';
    }

    function toggleLegacy(checked: boolean) {
        settingsStore.modelTier = checked ? 'legacy' : 'previous';
    }

    type OpenRouterRefreshState = 'idle' | 'loading' | 'success' | 'error';
    let openRouterRefreshState = $state<OpenRouterRefreshState>('idle');
    let openRouterRefreshStatusLoading = $state(true);
    let openRouterRefreshCoolingDown = $state(false);
    let openRouterRefreshTimer: ReturnType<typeof setTimeout> | undefined;

    let hasOpenRouterKey = $derived(
        providersStore.savedKeys?.openrouter === true
    );
    let openRouterRefreshDisabled = $derived(
        !hasOpenRouterKey ||
            openRouterRefreshStatusLoading ||
            openRouterRefreshCoolingDown ||
            openRouterRefreshState === 'loading'
    );

    function setOpenRouterRefreshCooldown(lastAttemptAt: number | null) {
        if (openRouterRefreshTimer !== undefined) {
            clearTimeout(openRouterRefreshTimer);
            openRouterRefreshTimer = undefined;
        }
        if (lastAttemptAt === null) {
            openRouterRefreshCoolingDown = false;
            return;
        }
        const remaining =
            lastAttemptAt + OPENROUTER_REFRESH_COOLDOWN_MS - Date.now();
        if (remaining <= 0) {
            openRouterRefreshCoolingDown = false;
            if (openRouterRefreshState !== 'loading') {
                openRouterRefreshState = 'idle';
            }
            return;
        }
        openRouterRefreshCoolingDown = true;
        openRouterRefreshTimer = setTimeout(() => {
            openRouterRefreshCoolingDown = false;
            openRouterRefreshState = 'idle';
            openRouterRefreshTimer = undefined;
        }, remaining);
    }

    $effect(() => {
        if (demo) return;
        let cancelled = false;
        waitForExtension()
            .then(() => getOpenRouterRefreshStatus())
            .then((lastAttemptAt) => {
                if (!cancelled) {
                    setOpenRouterRefreshCooldown(lastAttemptAt);
                }
            })
            .catch((err) => {
                if (!cancelled) {
                    reportAppError(
                        'OpenRouter refresh status load failed',
                        "Couldn't read OpenRouter refresh status",
                        err
                    );
                }
            })
            .finally(() => {
                if (!cancelled) openRouterRefreshStatusLoading = false;
            });
        return () => {
            cancelled = true;
            if (openRouterRefreshTimer !== undefined) {
                clearTimeout(openRouterRefreshTimer);
            }
        };
    });

    async function handleOpenRouterRefresh() {
        if (openRouterRefreshDisabled) return;
        setOpenRouterRefreshCooldown(Date.now());
        openRouterRefreshState = 'loading';
        try {
            await providersStore.refreshOpenRouterModels();
            openRouterRefreshState = 'success';
        } catch (err) {
            openRouterRefreshState = 'error';
            reportAppError(
                'OpenRouter model refresh failed',
                "Couldn't refresh OpenRouter models",
                err
            );
        }
    }

    let keyInputs = $state<Record<string, string>>(
        Object.fromEntries(PROVIDERS.map((p) => [p.id, '']))
    );

    $effect(() => {
        if (demo) return;
        waitForExtension().then(() => {
            providersStore.refreshSavedKeys().catch((err) => {
                reportAppError(
                    'checkApiKeys failed',
                    "Couldn't read saved API keys",
                    err
                );
            });
        });
    });

    type KeyTestStatus = 'testing' | 'ok' | 'fail';
    let keyTests = $state<Record<string, KeyTestStatus | undefined>>({});
    let keyTestError = $state<string | null>(null);

    async function handleTest(provider: { id: string; name: string }) {
        keyTests = { ...keyTests, [provider.id]: 'testing' };
        keyTestError = null;
        let result: { ok: boolean; message?: string };
        try {
            result = await testApiKey(provider.id);
        } catch (err) {
            result = { ok: false, message: formatErr(err) };
        }
        keyTests = { ...keyTests, [provider.id]: result.ok ? 'ok' : 'fail' };
        if (!result.ok) {
            keyTestError = `${provider.name}: ${result.message ?? 'key check failed'}`;
        }
    }

    async function handleSave(providerId: string) {
        const key = keyInputs[providerId].trim();
        if (!key) return;
        for (let i = 0; i < key.length; i++) {
            const code = key.charCodeAt(i);
            if (code < 32 || code > 126) {
                reportAppError(
                    `invalid API key characters (providerId=${providerId})`,
                    'API keys can only contain standard keyboard characters',
                    new Error(
                        'key contains non-printable or non-ASCII characters'
                    )
                );
                return;
            }
        }
        try {
            await saveApiKey(providerId, key);
        } catch (err) {
            reportAppError(
                `saveApiKey failed (providerId=${providerId})`,
                `Couldn't save API key for ${providerId}`,
                err
            );
            return;
        }
        keyInputs[providerId] = '';
        keyTests = { ...keyTests, [providerId]: undefined };
        providersStore.onApiKeySaved(providerId);
    }

    async function handleClear(providerId: string) {
        try {
            await clearApiKey(providerId);
        } catch (err) {
            reportAppError(
                `clearApiKey failed (providerId=${providerId})`,
                `Couldn't clear API key for ${providerId}`,
                err
            );
            return;
        }
        keyTests = { ...keyTests, [providerId]: undefined };
        providersStore.onApiKeyCleared(providerId);
    }

    const tabBase =
        'flex-1 px-2 py-3 bg-transparent border-0 text-sm text-fg whitespace-nowrap cursor-pointer transition-[color,background-color] duration-100 hover:bg-surface-raised';
    const tabActive =
        'text-accent-fg font-medium shadow-[inset_0_-2px_0_var(--color-accent-fg)]';

    const rowBase = 'flex flex-col gap-2';
    const themeRow = 'flex-row! items-center justify-between';

    const labelClass = 'text-sm text-fg font-medium';

    const selectClass =
        'w-auto px-2.5 py-[7px] bg-surface-raised border border-border rounded-md text-sm text-fg cursor-pointer';

    const rangeClass =
        'range-styled appearance-none w-full h-1 bg-surface-raised border-0 rounded p-0 cursor-pointer outline-none';

    const switchClass =
        'toggle-switch shrink-0 relative w-8.5 h-5 p-0 rounded-full cursor-pointer transition-[background-color,border-color] duration-200';

    const tdBase = 'py-2 px-3 text-fg align-middle';

    const lockedPanel = ['flex flex-col gap-5', demo && 'opacity-40'];

    function openInstallPrompt() {
        onclose();
        appLifecycle.requestExtension();
    }

    function onWindowKeydown(e: KeyboardEvent) {
        if (e.key === 'Escape') onclose();
    }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div
    class="fixed inset-0 z-49 bg-black/30"
    onclick={onclose}
    aria-hidden="true"
></div>

<div
    class="popover fixed top-1/2 left-1/2 z-50 flex w-[min(700px,calc(100vw-48px))] max-h-[calc(100vh-96px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-canvas shadow-[0_8px_40px_oklch(0%_0_0/20%)] select-none [&_input]:select-text"
    role="dialog"
    aria-label="Settings"
>
    <div class="flex border-b border-border">
        <button
            type="button"
            class={[tabBase, activeTab === 'keys' && tabActive]}
            onclick={() => (activeTab = 'keys')}
        >
            API Keys
        </button>
        <button
            type="button"
            class={[tabBase, activeTab === 'ui' && tabActive]}
            onclick={() => (activeTab = 'ui')}
        >
            UI
        </button>
        <button
            type="button"
            class={[tabBase, activeTab === 'tools' && tabActive]}
            onclick={() => (activeTab = 'tools')}
        >
            Tools
        </button>
        <button
            type="button"
            class={[tabBase, activeTab === 'storage' && tabActive]}
            onclick={openStorageTab}
        >
            Local Storage
        </button>
        <button
            type="button"
            class={[tabBase, activeTab === 'advanced' && tabActive]}
            onclick={() => (activeTab = 'advanced')}
        >
            Advanced
        </button>
        <button
            type="button"
            class={[tabBase, activeTab === 'changelog' && tabActive]}
            onclick={openChangelogTab}
        >
            Changelog
        </button>
    </div>

    <div class="grid flex-1 overflow-y-auto p-5">
        <div
            class={[
                'col-start-1 row-start-1 flex flex-col gap-5 invisible',
                activeTab === 'keys' && 'visible',
            ]}
            aria-hidden={activeTab !== 'keys'}
        >
            {#if demo}
                {@render demoNotice()}
            {/if}
            <div class={lockedPanel} inert={demo}>
                <table class="w-full border-collapse text-sm">
                    <thead>
                        <tr>
                            <th
                                class="text-left font-medium text-fg px-3 pb-2.5 border-b border-border"
                                >Provider</th
                            >
                            <th
                                class="text-center font-medium text-fg px-3 pb-2.5 border-b border-border"
                                >Saved</th
                            >
                            <th
                                class="text-left font-medium text-fg px-3 pb-2.5 border-b border-border w-full"
                                >API Key</th
                            >
                            <th
                                class="text-left font-medium text-fg px-3 pb-2.5 border-b border-border whitespace-nowrap"
                                >Options</th
                            >
                        </tr>
                    </thead>
                    <tbody>
                        {#each PROVIDERS as provider, i (provider.id)}
                            {@const isLast = i === PROVIDERS.length - 1}
                            <tr>
                                <td
                                    class={[
                                        tdBase,
                                        'font-medium whitespace-nowrap',
                                        !isLast && 'border-b border-border',
                                    ]}>{provider.name}</td
                                >
                                <td
                                    class={[
                                        tdBase,
                                        'text-center [&_svg]:block [&_svg]:mx-auto',
                                        !isLast && 'border-b border-border',
                                    ]}
                                >
                                    {#if providersStore.savedKeys?.[provider.id]}
                                        <Icon name="check" class="icon-check" />
                                    {:else}
                                        <Icon
                                            name="close"
                                            size={15}
                                            class="icon-x"
                                        />
                                    {/if}
                                </td>
                                <td
                                    class={[
                                        tdBase,
                                        'w-full',
                                        !isLast && 'border-b border-border',
                                    ]}
                                >
                                    <input
                                        class="w-full px-2.5 py-1.5 bg-surface-raised border border-border rounded-md text-sm text-fg font-mono box-border outline-none transition-[border-color] duration-150 focus:border-accent-fg placeholder:font-sans placeholder:text-fg-muted [-webkit-text-security:disc]"
                                        type="text"
                                        autocomplete="off"
                                        autocapitalize="off"
                                        spellcheck="false"
                                        placeholder="Paste key..."
                                        bind:value={keyInputs[provider.id]}
                                        onkeydown={(e) => {
                                            if (e.key === 'Enter')
                                                handleSave(provider.id);
                                        }}
                                    />
                                </td>
                                <td
                                    class={[
                                        tdBase,
                                        'whitespace-nowrap',
                                        !isLast && 'border-b border-border',
                                    ]}
                                >
                                    <div class="flex items-center gap-1.5">
                                        <button
                                            type="button"
                                            class="shrink-0 px-2.5 py-1.25 border-0 rounded-md text-xs font-medium cursor-pointer whitespace-nowrap transition-[background-color,color,opacity] duration-150 disabled:opacity-[0.35] disabled:cursor-not-allowed bg-accent-bg text-on-accent-bg enabled:hover:bg-accent-bg-hover enabled:hover:text-on-accent-bg-hover"
                                            disabled={!keyInputs[
                                                provider.id
                                            ].trim()}
                                            onclick={() =>
                                                handleSave(provider.id)}
                                        >
                                            Save
                                        </button>
                                        <button
                                            type="button"
                                            class="shrink-0 px-2.5 py-1.25 border border-border rounded-md text-xs font-medium cursor-pointer whitespace-nowrap transition-[background-color,opacity] duration-150 disabled:opacity-[0.35] disabled:cursor-not-allowed bg-surface-raised text-fg enabled:hover:bg-surface-sunken"
                                            disabled={!providersStore
                                                .savedKeys?.[provider.id]}
                                            onclick={() =>
                                                handleClear(provider.id)}
                                        >
                                            Clear
                                        </button>
                                        <button
                                            type="button"
                                            class={[
                                                'shrink-0 w-13 px-1 py-1.25 border rounded-md text-xs font-medium cursor-pointer whitespace-nowrap transition-[background-color,opacity,color,border-color] duration-150 disabled:opacity-[0.35] disabled:cursor-not-allowed bg-surface-raised enabled:hover:bg-surface-sunken [&_svg]:mx-auto',
                                                keyTests[provider.id] === 'ok'
                                                    ? 'text-[#4caf6e]! border-[#4caf6e]!'
                                                    : keyTests[provider.id] ===
                                                        'fail'
                                                      ? 'text-accent-fg! border-accent-fg!'
                                                      : 'text-fg border-border',
                                            ]}
                                            disabled={!providersStore
                                                .savedKeys?.[provider.id] ||
                                                keyTests[provider.id] ===
                                                    'testing'}
                                            onclick={() => handleTest(provider)}
                                        >
                                            {#if keyTests[provider.id] === 'testing'}
                                                <Icon name="spinner" />
                                            {:else if keyTests[provider.id] === 'ok'}
                                                Valid
                                            {:else if keyTests[provider.id] === 'fail'}
                                                Invalid
                                            {:else}
                                                Test
                                            {/if}
                                        </button>
                                    </div>
                                </td>
                            </tr>
                        {/each}
                    </tbody>
                </table>
                {#if keyTestError}
                    <p
                        class="m-0 -mt-2 px-3 text-xs text-accent-fg wrap-break-word"
                        role="alert"
                    >
                        {keyTestError}
                    </p>
                {/if}
            </div>
        </div>

        <div
            class={[
                'col-start-1 row-start-1 flex flex-col gap-5 invisible',
                activeTab === 'ui' && 'visible',
            ]}
            aria-hidden={activeTab !== 'ui'}
        >
            <div class={[rowBase, themeRow]}>
                <label for="theme-select" class={labelClass}>Theme</label>
                <select
                    id="theme-select"
                    class={selectClass}
                    bind:value={settingsStore.theme}
                >
                    {#each THEMES as t (t.id)}
                        <option value={t.id}>{t.name}</option>
                    {/each}
                </select>
            </div>
            <div class={[rowBase, themeRow]}>
                <label for="message-font" class={labelClass}>Message Font</label
                >
                <select
                    id="message-font"
                    class={selectClass}
                    style="font-family: var(--font-message)"
                    bind:value={settingsStore.messageFont}
                >
                    <option value="serif" style="font-family: var(--font-serif)"
                        >Serif</option
                    >
                    <option value="sans" style="font-family: var(--font-sans)"
                        >Sans</option
                    >
                </select>
            </div>
            <div class={rowBase}>
                <label for="font-size" class={labelClass}>Text Size</label>
                <input
                    type="range"
                    id="font-size"
                    class={rangeClass}
                    min="0"
                    max="5"
                    step="1"
                    bind:value={settingsStore.fontSizeIndex}
                />
                <div
                    class="flex justify-between text-[0.6875rem] text-fg -mt-1"
                >
                    <span>Smaller</span>
                    <span>Larger</span>
                </div>
            </div>
            <div class={rowBase}>
                <label for="chat-width" class={labelClass}>Chat Width</label>
                <input
                    type="range"
                    id="chat-width"
                    class={rangeClass}
                    min="0"
                    max="100"
                    step="1"
                    bind:value={settingsStore.chatWidth}
                />
                <div
                    class="flex justify-between text-[0.6875rem] text-fg -mt-1"
                >
                    <span>Narrower</span>
                    <span>Wider</span>
                </div>
            </div>
            <div class={[rowBase, themeRow]}>
                <label for="submit-keystroke" class={labelClass}
                    >Submit Keystroke</label
                >
                <select
                    id="submit-keystroke"
                    class={selectClass}
                    bind:value={settingsStore.submitKeystroke}
                >
                    <option value="enter">Enter</option>
                    <option value="ctrl+enter">Control+Enter</option>
                </select>
            </div>
            <div class={[rowBase, themeRow]}>
                <label for="autoscroll-mode" class={labelClass}
                    >Autoscroll Mode</label
                >
                <select
                    id="autoscroll-mode"
                    class={selectClass}
                    bind:value={settingsStore.autoscrollMode}
                >
                    <option value="pin-user-message"
                        >Scroll to user message</option
                    >
                    <option value="pin-bottom">Scroll to bottom</option>
                    <option value="off">Off</option>
                </select>
            </div>
            <div class={[rowBase, themeRow]}>
                <label for="show-previous" class={labelClass}
                    >Show Previous Generation Models</label
                >
                <button
                    id="show-previous"
                    type="button"
                    class={[switchClass, showPrevious && 'on']}
                    role="switch"
                    aria-checked={showPrevious}
                    aria-label="Show Previous Generation Models"
                    onclick={() => {
                        togglePrevious(!showPrevious);
                    }}
                >
                    <span class="toggle-switch-thumb"></span>
                </button>
            </div>
        </div>

        <div
            class={[
                'col-start-1 row-start-1 flex flex-col gap-5 invisible',
                activeTab === 'tools' && 'visible',
            ]}
            aria-hidden={activeTab !== 'tools'}
        >
            {#if demo}
                {@render demoNotice()}
            {/if}
            <div class={lockedPanel} inert={demo}>
                <div class={[rowBase, themeRow]}>
                    <div class="flex items-center gap-1.25">
                        <label for="enable-web-search" class={labelClass}
                            >Web Search</label
                        >
                        {@render toolInfo('About web search', WEB_SEARCH_INFO)}
                    </div>
                    <button
                        id="enable-web-search"
                        type="button"
                        class={[
                            switchClass,
                            settingsStore.enableWebSearch && 'on',
                        ]}
                        role="switch"
                        aria-checked={settingsStore.enableWebSearch}
                        aria-label="Enable Web Search"
                        onclick={() => {
                            settingsStore.enableWebSearch =
                                !settingsStore.enableWebSearch;
                        }}
                    >
                        <span class="toggle-switch-thumb"></span>
                    </button>
                </div>
                <div class={[rowBase, themeRow]}>
                    <div class="flex items-center gap-1.25">
                        <label for="enable-web-fetch" class={labelClass}
                            >Web Fetch</label
                        >
                        {@render toolInfo('About web fetch', WEB_FETCH_INFO)}
                    </div>
                    <button
                        id="enable-web-fetch"
                        type="button"
                        class={[
                            switchClass,
                            settingsStore.enableWebFetch && 'on',
                        ]}
                        role="switch"
                        aria-checked={settingsStore.enableWebFetch}
                        aria-label="Enable Web Fetch"
                        onclick={() => {
                            settingsStore.enableWebFetch =
                                !settingsStore.enableWebFetch;
                        }}
                    >
                        <span class="toggle-switch-thumb"></span>
                    </button>
                </div>
                <div class={[rowBase, themeRow]}>
                    <div class="flex items-center gap-1.25">
                        <label for="enable-code-execution" class={labelClass}
                            >Code Execution</label
                        >
                        {@render toolInfo(
                            'About code execution',
                            CODE_EXECUTION_INFO
                        )}
                    </div>
                    <button
                        id="enable-code-execution"
                        type="button"
                        class={[
                            switchClass,
                            settingsStore.enableCodeExecution && 'on',
                        ]}
                        role="switch"
                        aria-checked={settingsStore.enableCodeExecution}
                        aria-label="Enable Code Execution"
                        onclick={() => {
                            settingsStore.enableCodeExecution =
                                !settingsStore.enableCodeExecution;
                        }}
                    >
                        <span class="toggle-switch-thumb"></span>
                    </button>
                </div>
                <div class={[rowBase, themeRow]}>
                    <label for="enable-file-uploads" class={labelClass}
                        >File Uploads</label
                    >
                    <button
                        id="enable-file-uploads"
                        type="button"
                        class={[
                            switchClass,
                            settingsStore.enableFileUploads && 'on',
                        ]}
                        role="switch"
                        aria-checked={settingsStore.enableFileUploads}
                        aria-label="Enable File Uploads"
                        onclick={() => {
                            settingsStore.setFileUploadsEnabled(
                                !settingsStore.enableFileUploads
                            );
                        }}
                    >
                        <span class="toggle-switch-thumb"></span>
                    </button>
                </div>
                <div
                    class={[
                        rowBase,
                        themeRow,
                        'pl-5',
                        !settingsStore.enableFileUploads && 'opacity-50',
                    ]}
                >
                    <div class="flex items-center gap-1.25">
                        <label
                            for="enable-provider-file-storage"
                            class={labelClass}>Provider File Storage</label
                        >
                        {@render toolInfo(
                            'About provider file storage',
                            PROVIDER_FILE_STORAGE_INFO
                        )}
                    </div>
                    <button
                        id="enable-provider-file-storage"
                        type="button"
                        class={[
                            switchClass,
                            settingsStore.enableProviderFileStorage && 'on',
                            !settingsStore.enableFileUploads &&
                                'cursor-not-allowed',
                        ]}
                        role="switch"
                        aria-checked={settingsStore.enableProviderFileStorage}
                        aria-label="Enable Provider File Storage"
                        disabled={!settingsStore.enableFileUploads}
                        onclick={() => {
                            settingsStore.enableProviderFileStorage =
                                !settingsStore.enableProviderFileStorage;
                        }}
                    >
                        <span class="toggle-switch-thumb"></span>
                    </button>
                </div>
                <p class="m-0 text-xs leading-normal text-fg-muted">
                    {FILE_UPLOADS_WARNING}
                </p>
            </div>
        </div>

        <div
            class={[
                'col-start-1 row-start-1 flex flex-col gap-5 invisible',
                activeTab === 'storage' && 'visible',
            ]}
            aria-hidden={activeTab !== 'storage'}
        >
            {#if demo}
                {@render demoNotice()}
            {/if}
            <div class={lockedPanel} inert={demo}>
                <div class="flex flex-col gap-2.5">
                    {#each storageRows as row (row.label)}
                        <div
                            class="flex items-center justify-between py-1.5 border-b border-border"
                        >
                            <span class="text-sm text-fg">{row.label}</span>
                            <span
                                class="text-sm tabular-nums text-fg-muted font-mono"
                            >
                                {storageUsage
                                    ? `${row.approximate ? '~' : ''}${formatFileSize(row.bytes)}`
                                    : '-'}
                            </span>
                        </div>
                    {/each}
                    <div class="flex items-center justify-between py-1.5">
                        <span class="text-sm text-fg font-medium">Total</span>
                        <span
                            class="text-sm tabular-nums text-fg font-mono font-medium"
                        >
                            {storageUsage
                                ? `~${formatFileSize(storageTotal)}`
                                : '-'}
                        </span>
                    </div>
                    <p class="m-0 text-xs text-fg-muted">
                        Sizes reflect storage on your device. Files uploaded
                        with Provider File Storage also have copies on provider
                        servers, which can be managed in the Files tab.
                    </p>
                </div>
                <div class="flex flex-col gap-2">
                    <div class="flex gap-2">
                        <button
                            type="button"
                            class="flex-1 flex items-center justify-center gap-2 px-3 py-2 border border-accent-fg rounded-md text-sm font-medium cursor-pointer whitespace-nowrap transition-[background-color,color,opacity] duration-150 bg-transparent text-accent-fg enabled:hover:bg-accent-bg enabled:hover:text-on-accent-bg disabled:opacity-[0.35] disabled:cursor-not-allowed"
                            disabled={transferBusy}
                            onclick={handleExportAll}
                        >
                            <Icon name="download" />
                            Export all chats
                        </button>
                        <button
                            type="button"
                            class="flex-1 flex items-center justify-center gap-2 px-3 py-2 border border-accent-fg rounded-md text-sm font-medium cursor-pointer whitespace-nowrap transition-[background-color,color,opacity] duration-150 bg-transparent text-accent-fg enabled:hover:bg-accent-bg enabled:hover:text-on-accent-bg disabled:opacity-[0.35] disabled:cursor-not-allowed"
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
                        Export downloads a readable YAML backup of all chats
                        (uploaded files are not included). Import accepts
                        AirmailAI backups, plus single-chat Markdown, LM Studio
                        JSON, and SillyTavern JSONL files.
                    </p>
                </div>
                <div class="flex gap-2">
                    <button
                        type="button"
                        class="flex-1 flex items-center justify-center gap-2 px-3 py-2 border border-accent-fg rounded-md text-sm font-medium cursor-pointer whitespace-nowrap transition-[background-color,color,opacity] duration-150 bg-transparent text-accent-fg enabled:hover:bg-accent-bg enabled:hover:text-on-accent-bg disabled:opacity-[0.35] disabled:cursor-not-allowed"
                        disabled={storageBusy || storageLoading}
                        onclick={handleClearChats}
                    >
                        <Icon name="trash" />
                        Delete chat history
                    </button>
                    <button
                        type="button"
                        class="flex-1 flex items-center justify-center gap-2 px-3 py-2 border border-accent-fg rounded-md text-sm font-medium cursor-pointer whitespace-nowrap transition-[background-color,color,opacity] duration-150 bg-transparent text-accent-fg enabled:hover:bg-accent-bg enabled:hover:text-on-accent-bg disabled:opacity-[0.35] disabled:cursor-not-allowed"
                        disabled={storageBusy || storageLoading}
                        onclick={handleClearAll}
                    >
                        <Icon name="trash" />
                        Delete all local storage
                    </button>
                </div>
            </div>
        </div>

        <div
            class={[
                'col-start-1 row-start-1 flex flex-col gap-5 invisible',
                activeTab === 'advanced' && 'visible',
            ]}
            aria-hidden={activeTab !== 'advanced'}
        >
            <div class={[rowBase, themeRow]}>
                <div class="flex items-center gap-1.25">
                    <label for="smooth-text-mode" class={labelClass}
                        >Smooth Text Rendering</label
                    >
                    {@render toolInfo(
                        'About smooth text rendering',
                        SMOOTH_TEXT_INFO
                    )}
                </div>
                <select
                    id="smooth-text-mode"
                    class={selectClass}
                    bind:value={settingsStore.smoothTextMode}
                >
                    <option value="smooth">Smooth rendering</option>
                    <option value="raw"
                        >Render text chunks as streamed from API</option
                    >
                </select>
            </div>
            <div class={[rowBase, themeRow]}>
                <label for="chat-sort-order" class={labelClass}
                    >Sort Chats By</label
                >
                <select
                    id="chat-sort-order"
                    class={selectClass}
                    bind:value={settingsStore.chatSortOrder}
                >
                    <option value="modified">Last updated</option>
                    <option value="created">Date created</option>
                </select>
            </div>
            <div class={[rowBase, themeRow]}>
                <label for="show-legacy" class={labelClass}
                    >Show Legacy Models</label
                >
                <button
                    id="show-legacy"
                    type="button"
                    class={[switchClass, showLegacy && 'on']}
                    role="switch"
                    aria-checked={showLegacy}
                    aria-label="Show Legacy Models"
                    onclick={() => {
                        toggleLegacy(!showLegacy);
                    }}
                >
                    <span class="toggle-switch-thumb"></span>
                </button>
            </div>
            <div class={[rowBase, themeRow]}>
                <label for="show-branding" class={labelClass}
                    >Show Branding</label
                >
                <select
                    id="show-branding"
                    class={selectClass}
                    bind:value={settingsStore.brandingMode}
                >
                    <option value="on">On</option>
                    <option value="stripes">Show stripes</option>
                    <option value="off">Off</option>
                </select>
            </div>
            <div class={[rowBase, themeRow]}>
                <label for="tag-openrouter" class={labelClass}
                    >Tag OpenRouter requests with 'AirmailAI' for <a
                        href="https://openrouter.ai/apps?url=https%3A%2F%2Fairmailai.net%2F"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="inline-flex items-center gap-0.5 text-accent-fg no-underline hover:underline"
                        onclick={(e) => e.stopPropagation()}
                        >app tracking<Icon name="external-link" /></a
                    ></label
                >
                <button
                    id="tag-openrouter"
                    type="button"
                    class={[
                        switchClass,
                        settingsStore.tagOpenRouterRequests && 'on',
                    ]}
                    role="switch"
                    aria-checked={settingsStore.tagOpenRouterRequests}
                    aria-label="Tag OpenRouter requests with AirmailAI for app tracking"
                    onclick={() => {
                        settingsStore.tagOpenRouterRequests =
                            !settingsStore.tagOpenRouterRequests;
                    }}
                >
                    <span class="toggle-switch-thumb"></span>
                </button>
            </div>
            <div title={demo ? DEMO_LOCKED_TITLE : undefined}>
                <div
                    class={[rowBase, themeRow, demo && 'opacity-40']}
                    inert={demo}
                >
                    <label for="refresh-openrouter-models" class={labelClass}
                        >Refresh OpenRouter Model List</label
                    >
                    <div class="flex items-center gap-2">
                        {#if openRouterRefreshState === 'loading'}
                            <Icon name="spinner" class="text-fg-muted" />
                        {/if}
                        <button
                            id="refresh-openrouter-models"
                            type="button"
                            class={[
                                'w-20 shrink-0 px-2.5 py-1.25 border rounded-md bg-surface-raised text-xs font-medium cursor-pointer whitespace-nowrap transition-[background-color,opacity,color,border-color] duration-150 enabled:hover:bg-surface-sunken disabled:cursor-not-allowed',
                                openRouterRefreshState === 'error'
                                    ? 'text-accent-fg! border-accent-fg! disabled:opacity-100!'
                                    : 'text-fg border-border disabled:opacity-[0.35]',
                            ]}
                            title={openRouterRefreshCoolingDown
                                ? OPENROUTER_REFRESH_COOLDOWN_TITLE
                                : undefined}
                            disabled={openRouterRefreshDisabled}
                            onclick={handleOpenRouterRefresh}
                        >
                            {#if openRouterRefreshState === 'success'}
                                Refreshed
                            {:else if openRouterRefreshState === 'error'}
                                Error
                            {:else}
                                Refresh
                            {/if}
                        </button>
                    </div>
                </div>
            </div>
            <div class={[rowBase, themeRow]}>
                <div class="flex items-center gap-1.25">
                    <label for="openrouter-pdf-engine" class={labelClass}
                        >OpenRouter PDF Processing</label
                    >
                    {@render toolInfo(
                        'About OpenRouter PDF processing',
                        OPENROUTER_PDF_INFO,
                        true
                    )}
                </div>
                <select
                    id="openrouter-pdf-engine"
                    class={selectClass}
                    bind:value={settingsStore.openRouterPdfEngine}
                >
                    <option value="native">Provider native only</option>
                    <option value="auto"
                        >Provider native preferred, Cloudflare fallback</option
                    >
                    <option value="cloudflare-ai"
                        >Cloudflare processing only</option
                    >
                    <option value="mistral-ocr">Mistral-OCR (paid)</option>
                </select>
            </div>
            <p class="m-0 mt-auto pt-2 text-xs text-fg-muted text-center">
                AirmailAI is made possible by <a
                    href="/legal/third-party-licenses.txt"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="inline-flex items-center gap-0.5 text-accent-fg no-underline hover:underline"
                    >open source software<Icon name="external-link" /></a
                >.
                <a
                    href="/legal/terms.md"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="inline-flex items-center gap-0.5 text-accent-fg no-underline hover:underline"
                    >Terms of Service</a
                >
                /
                <a
                    href="/legal/privacy.md"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="inline-flex items-center gap-0.5 text-accent-fg no-underline hover:underline"
                    >Privacy Policy</a
                >
            </p>
        </div>

        <div
            class={[
                'col-start-1 row-start-1 flex flex-col gap-5 invisible select-text',
                activeTab === 'changelog' && 'visible',
            ]}
            aria-hidden={activeTab !== 'changelog'}
        >
            {#if changelogError}
                <p class="text-sm text-accent-fg m-0 py-1">{changelogError}</p>
            {:else if changelogMd === null}
                <p class="text-sm text-fg m-0 py-1">Loading...</p>
            {:else}
                <MarkdownMessage content={changelogMd} />
            {/if}
        </div>
    </div>
</div>

{#snippet demoNotice()}
    <p class="m-0 text-sm text-fg">
        Faded settings require the <button
            type="button"
            class="inline-flex items-center gap-0.5 p-0 bg-transparent border-0 font-sans text-sm text-accent-fg cursor-pointer hover:underline"
            onclick={openInstallPrompt}
            >AirmailAI extension<Icon name="external-link" /></button
        >
    </p>
{/snippet}

{#snippet toolInfo(label: string, text: string, above: boolean = false)}
    <span
        class="info-icon relative flex items-center text-fg-muted opacity-60 cursor-default hover:opacity-100"
        aria-label={label}
    >
        <Icon name="info" />
        <span
            class={[
                'info-tooltip hidden absolute left-0 w-72 px-2.5 py-2 bg-surface-raised border border-border rounded-[7px] text-xs leading-normal text-fg font-normal shadow-[0_4px_16px_oklch(0%_0_0/15%)] pointer-events-none z-10',
                above ? 'bottom-[calc(100%+6px)]' : 'top-[calc(100%+6px)]',
            ]}>{text}</span
        >
    </span>
{/snippet}

<style>
    :global(.icon-check) {
        color: #4caf6e;
    }

    :global(.icon-x) {
        color: var(--color-fg-muted);
    }
</style>
