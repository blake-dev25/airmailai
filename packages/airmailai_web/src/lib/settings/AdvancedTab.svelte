<script lang="ts">
    import { OPENROUTER_REFRESH_COOLDOWN_MS } from '@airmailai/shared';
    import { appMode } from '../appMode.svelte';
    import { defaultModelForProvider } from '../constants';
    import Dropdown from '../Dropdown.svelte';
    import { reportAppError } from '../errorStore.svelte';
    import { getOpenRouterRefreshStatus, waitForExtension } from '../extension';
    import Icon from '../Icon.svelte';
    import { providersStore } from '../providersStore.svelte';
    import { settingsStore } from '../settingsStore.svelte';
    import InfoTip from './InfoTip.svelte';
    import {
        settingLabelClass,
        settingRowClass,
        settingRowInlineClass,
    } from './styles';
    import ToggleSwitch from '../ToggleSwitch.svelte';

    const demo = appMode.isDemo;

    const SMOOTH_TEXT_INFO =
        'Changes how AI messages are displayed. Smooth animates text in at a steady pace; raw displays chunks exactly as they arrive.';
    const OPENROUTER_PDF_INFO =
        'Controls how PDFs are processed in OpenRouter chats. "Provider native only" sends the PDF to the model provider and nowhere else, but only works with models that support PDF input. The Cloudflare and Mistral options parse the PDF into text first, which lets any model read PDFs but routes the file contents through that third party. Mistral OCR bills per page to your OpenRouter account; Cloudflare parsing is free.';
    const OPENROUTER_REFRESH_COOLDOWN_TITLE =
        'Recently refreshed, please wait 5m to try again.';
    const DEMO_LOCKED_TITLE = 'Requires the AirmailAI extension';

    let showLegacy = $derived(settingsStore.modelTier === 'legacy');

    function toggleLegacy(checked: boolean) {
        settingsStore.modelTier = checked ? 'legacy' : 'latest';
    }

    function toggleCustomModel(checked: boolean) {
        const provider = providersStore.providers.find(
            (p) => p.id === settingsStore.providerId
        );
        settingsStore.setCustomModelEnabled(
            checked,
            provider ? defaultModelForProvider(provider) : undefined
        );
    }

    type OpenRouterRefreshState =
        | { kind: 'checking' }
        | { kind: 'ready' }
        | { kind: 'refreshing'; until: number }
        | {
              kind: 'cooldown';
              until: number;
              lastResult: 'success' | 'error' | null;
          };
    let openRouterRefresh = $state.raw<OpenRouterRefreshState>({
        kind: 'checking',
    });
    let openRouterCooldownTimer: ReturnType<typeof setTimeout> | undefined;
    let openRouterLastResult = $derived(
        openRouterRefresh.kind === 'cooldown'
            ? openRouterRefresh.lastResult
            : null
    );

    let hasOpenRouterKey = $derived(providersStore.hasSavedKey('openrouter'));
    let openRouterRefreshDisabled = $derived(
        !hasOpenRouterKey || openRouterRefresh.kind !== 'ready'
    );

    function scheduleCooldownEnd(until: number) {
        clearTimeout(openRouterCooldownTimer);
        openRouterCooldownTimer = setTimeout(() => {
            if (openRouterRefresh.kind === 'cooldown') {
                openRouterRefresh = { kind: 'ready' };
            }
        }, until - Date.now());
    }

    function settleOpenRouterRefresh(
        until: number,
        lastResult: 'success' | 'error' | null
    ) {
        openRouterRefresh =
            until > Date.now()
                ? { kind: 'cooldown', until, lastResult }
                : { kind: 'ready' };
    }

    $effect(() => {
        if (demo) return;
        let cancelled = false;
        waitForExtension()
            .then(() => getOpenRouterRefreshStatus())
            .then((lastAttemptAt) => {
                if (cancelled) return;
                if (lastAttemptAt === null) {
                    openRouterRefresh = { kind: 'ready' };
                    return;
                }
                const until = lastAttemptAt + OPENROUTER_REFRESH_COOLDOWN_MS;
                settleOpenRouterRefresh(until, null);
                scheduleCooldownEnd(until);
            })
            .catch((err) => {
                if (cancelled) return;
                openRouterRefresh = { kind: 'ready' };
                reportAppError(
                    'OpenRouter refresh status load failed',
                    "Couldn't read OpenRouter refresh status",
                    err
                );
            });
        return () => {
            cancelled = true;
            clearTimeout(openRouterCooldownTimer);
        };
    });

    async function handleOpenRouterRefresh() {
        if (openRouterRefreshDisabled) return;
        const until = Date.now() + OPENROUTER_REFRESH_COOLDOWN_MS;
        openRouterRefresh = { kind: 'refreshing', until };
        scheduleCooldownEnd(until);
        try {
            await providersStore.refreshOpenRouterModels();
            settleOpenRouterRefresh(until, 'success');
        } catch (err) {
            settleOpenRouterRefresh(until, 'error');
            reportAppError(
                'OpenRouter model refresh failed',
                "Couldn't refresh OpenRouter models",
                err
            );
        }
    }
</script>

<div class={[settingRowClass, settingRowInlineClass]}>
    <div class="flex items-center gap-1.25">
        <label for="smooth-text-mode" class={settingLabelClass}
            >Smooth Text Rendering</label
        >
        <InfoTip label="About smooth text rendering" text={SMOOTH_TEXT_INFO} />
    </div>
    <Dropdown
        id="smooth-text-mode"
        bind:value={settingsStore.smoothTextMode}
        options={[
            { id: 'smooth', name: 'Smooth rendering' },
            {
                id: 'raw',
                name: 'Render text chunks as streamed from API',
            },
        ]}
    />
</div>
<div class={[settingRowClass, settingRowInlineClass]}>
    <label for="chat-sort-order" class={settingLabelClass}>Sort Chats By</label>
    <Dropdown
        id="chat-sort-order"
        bind:value={settingsStore.chatSortOrder}
        options={[
            { id: 'modified', name: 'Last updated' },
            { id: 'created', name: 'Date created' },
        ]}
    />
</div>
<div class={[settingRowClass, settingRowInlineClass]}>
    <label for="show-legacy" class={settingLabelClass}>Show Legacy Models</label
    >
    <ToggleSwitch
        id="show-legacy"
        checked={showLegacy}
        label="Show Legacy Models"
        onchange={toggleLegacy}
    />
</div>
<div class={[settingRowClass, settingRowInlineClass]}>
    <label for="show-branding" class={settingLabelClass}>Show Branding</label>
    <Dropdown
        id="show-branding"
        bind:value={settingsStore.brandingMode}
        options={[
            { id: 'on', name: 'On' },
            { id: 'stripes', name: 'Show stripes' },
            { id: 'off', name: 'Off' },
        ]}
    />
</div>
<div class={[settingRowClass, settingRowInlineClass]}>
    <label for="tag-openrouter" class={settingLabelClass}
        >Tag OpenRouter requests with 'AirmailAI' for <a
            href="https://openrouter.ai/apps?url=https%3A%2F%2Fairmailai.net%2F"
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex items-center gap-0.5 text-accent-fg no-underline hover:underline"
            onclick={(e) => e.stopPropagation()}
            >app tracking<Icon name="external-link" /></a
        ></label
    >
    <ToggleSwitch
        id="tag-openrouter"
        checked={settingsStore.tagOpenRouterRequests}
        label="Tag OpenRouter requests with AirmailAI for app tracking"
        onchange={(checked) => {
            settingsStore.tagOpenRouterRequests = checked;
        }}
    />
</div>
<div title={demo ? DEMO_LOCKED_TITLE : undefined}>
    <div
        class={[settingRowClass, settingRowInlineClass, demo && 'opacity-40']}
        inert={demo}
    >
        <label for="refresh-openrouter-models" class={settingLabelClass}
            >Refresh OpenRouter Model List</label
        >
        <div class="flex items-center gap-2">
            {#if openRouterRefresh.kind === 'refreshing'}
                <Icon name="spinner" class="text-fg-muted" />
            {/if}
            <button
                id="refresh-openrouter-models"
                type="button"
                class={[
                    'w-20 shrink-0 px-2.5 py-1.25 border rounded-md bg-surface-raised text-xs font-medium cursor-pointer whitespace-nowrap transition-[background-color,opacity,color,border-color] duration-150 enabled:hover:bg-surface-sunken disabled:cursor-not-allowed',
                    openRouterLastResult === 'error'
                        ? 'text-accent-fg! border-accent-fg! disabled:opacity-100!'
                        : 'text-fg border-border disabled:opacity-[0.35]',
                ]}
                title={openRouterRefresh.kind === 'refreshing' ||
                openRouterRefresh.kind === 'cooldown'
                    ? OPENROUTER_REFRESH_COOLDOWN_TITLE
                    : undefined}
                disabled={openRouterRefreshDisabled}
                onclick={handleOpenRouterRefresh}
            >
                {#if openRouterLastResult === 'success'}
                    Refreshed
                {:else if openRouterLastResult === 'error'}
                    Error
                {:else}
                    Refresh
                {/if}
            </button>
        </div>
    </div>
</div>
<div class={[settingRowClass, settingRowInlineClass]}>
    <div class="flex items-center gap-1.25">
        <label for="openrouter-pdf-engine" class={settingLabelClass}
            >OpenRouter PDF Processing</label
        >
        <InfoTip
            label="About OpenRouter PDF processing"
            text={OPENROUTER_PDF_INFO}
            above
        />
    </div>
    <Dropdown
        id="openrouter-pdf-engine"
        bind:value={settingsStore.openRouterPdfEngine}
        options={[
            { id: 'native', name: 'Provider native only' },
            {
                id: 'auto',
                name: 'Provider native preferred, Cloudflare fallback',
            },
            {
                id: 'cloudflare-ai',
                name: 'Cloudflare processing only',
            },
            { id: 'mistral-ocr', name: 'Mistral-OCR (paid)' },
        ]}
    />
</div>
<div class={[settingRowClass, settingRowInlineClass]}>
    <div class="flex items-center gap-1.25">
        <label for="custom-model-configuration" class={settingLabelClass}
            >Custom Model Configuration</label
        >
        <InfoTip
            label="About custom model configuration"
            text="Enter a model ID and parameters manually. Blank fields are omitted from requests."
            above
        />
    </div>
    <ToggleSwitch
        id="custom-model-configuration"
        checked={!!settingsStore.customModel}
        label="Custom Model Configuration"
        onchange={toggleCustomModel}
    />
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
