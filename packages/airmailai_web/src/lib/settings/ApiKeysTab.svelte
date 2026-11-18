<script lang="ts">
    import type { ProviderId } from '@airmailai/shared';
    import { errorMessage } from '@airmailai/shared';
    import { appMode } from '../appMode.svelte';
    import { PROVIDER_META } from '../constants';
    import { reportAppError } from '../errorStore.svelte';
    import {
        clearApiKey,
        saveApiKey,
        testApiKey,
        waitForExtension,
    } from '../extension';
    import Icon from '../Icon.svelte';
    import { providersStore } from '../providersStore.svelte';
    import DemoLockedPanel from './DemoLockedPanel.svelte';

    type KeyTest =
        | { kind: 'testing' }
        | { kind: 'ok' }
        | { kind: 'fail'; message: string };

    let keyInputs = $state<Record<string, string>>(
        Object.fromEntries(PROVIDER_META.map((p) => [p.id, '']))
    );
    let keyTests = $state<Partial<Record<ProviderId, KeyTest>>>({});

    const keyTestFailures = $derived(
        PROVIDER_META.flatMap((provider) => {
            const test = keyTestFor(provider.id);
            return test?.kind === 'fail'
                ? [
                      {
                          id: provider.id,
                          message: `${provider.name}: ${test.message}`,
                      },
                  ]
                : [];
        })
    );

    $effect(() => {
        if (appMode.isDemo) return;
        waitForExtension().then(() => providersStore.refreshSavedKeys());
    });

    function keyTestFor(providerId: ProviderId): KeyTest | undefined {
        return providersStore.hasSavedKey(providerId)
            ? keyTests[providerId]
            : undefined;
    }

    async function handleTest(providerId: ProviderId) {
        keyTests[providerId] = { kind: 'testing' };
        let result: { ok: boolean; message?: string };
        try {
            result = await testApiKey(providerId);
        } catch (err) {
            result = { ok: false, message: errorMessage(err) };
        }
        keyTests[providerId] = result.ok
            ? { kind: 'ok' }
            : { kind: 'fail', message: result.message ?? 'key check failed' };
    }

    async function handleSave(providerId: ProviderId) {
        const key = keyInputs[providerId].trim();
        if (!key) return;
        for (let i = 0; i < key.length; i++) {
            const code = key.charCodeAt(i);
            if (code < 32 || code > 126) {
                reportAppError(
                    `invalid API key characters (providerId=${providerId})`,
                    'API keys can only contain standard keyboard characters',
                    'key contains non-printable or non-ASCII characters'
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
        keyTests[providerId] = undefined;
        providersStore.onApiKeySaved(providerId);
    }

    async function handleClear(providerId: ProviderId) {
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
        keyTests[providerId] = undefined;
        providersStore.onApiKeyCleared(providerId);
    }

    const tdBase = 'py-2 px-3 text-fg align-middle';
</script>

<DemoLockedPanel>
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
            {#each PROVIDER_META as provider, i (provider.id)}
                {@const isLast = i === PROVIDER_META.length - 1}
                {@const test = keyTestFor(provider.id)}
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
                        {#if providersStore.hasSavedKey(provider.id)}
                            <Icon name="check" class="icon-check" />
                        {:else}
                            <Icon name="close" size={15} class="icon-x" />
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
                                if (e.key === 'Enter') handleSave(provider.id);
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
                                disabled={!keyInputs[provider.id].trim()}
                                onclick={() => handleSave(provider.id)}
                            >
                                Save
                            </button>
                            <button
                                type="button"
                                class="shrink-0 px-2.5 py-1.25 border border-border rounded-md text-xs font-medium cursor-pointer whitespace-nowrap transition-[background-color,opacity] duration-150 disabled:opacity-[0.35] disabled:cursor-not-allowed bg-surface-raised text-fg enabled:hover:bg-surface-sunken"
                                disabled={!providersStore.hasSavedKey(
                                    provider.id
                                )}
                                onclick={() => handleClear(provider.id)}
                            >
                                Clear
                            </button>
                            <button
                                type="button"
                                class={[
                                    'shrink-0 w-13 px-1 py-1.25 border rounded-md text-xs font-medium cursor-pointer whitespace-nowrap transition-[background-color,opacity,color,border-color] duration-150 disabled:opacity-[0.35] disabled:cursor-not-allowed bg-surface-raised enabled:hover:bg-surface-sunken [&_svg]:mx-auto',
                                    test?.kind === 'ok'
                                        ? 'text-[#4caf6e]! border-[#4caf6e]!'
                                        : test?.kind === 'fail'
                                          ? 'text-accent-fg! border-accent-fg!'
                                          : 'text-fg border-border',
                                ]}
                                disabled={!providersStore.hasSavedKey(
                                    provider.id
                                ) || test?.kind === 'testing'}
                                onclick={() => handleTest(provider.id)}
                            >
                                {#if test?.kind === 'testing'}
                                    <Icon name="spinner" />
                                {:else if test?.kind === 'ok'}
                                    Valid
                                {:else if test?.kind === 'fail'}
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
    {#if keyTestFailures.length}
        <div class="flex flex-col gap-1 -mt-2 px-3">
            {#each keyTestFailures as failure (failure.id)}
                <p
                    class="m-0 text-xs text-accent-fg wrap-break-word"
                    role="alert"
                >
                    {failure.message}
                </p>
            {/each}
        </div>
    {/if}
</DemoLockedPanel>

<style>
    :global(.icon-check) {
        color: #4caf6e;
    }

    :global(.icon-x) {
        color: var(--color-fg-muted);
    }
</style>
