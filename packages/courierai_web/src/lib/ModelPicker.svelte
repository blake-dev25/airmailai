<script module lang="ts">
    import type { ModelOption } from './constants';

    export interface ModelGroup {
        label: string;
        pinned?: boolean;
        models: ModelOption[];
    }
</script>

<script lang="ts">
    import Icon from './Icon.svelte';

    let {
        groups,
        value = $bindable(),
        onchange,
        disabled = false,
        emptyLabel = 'Loading models...',
    }: {
        groups: ModelGroup[];
        value: string;
        onchange?: (id: string) => void;
        disabled?: boolean;
        emptyLabel?: string;
    } = $props();

    const SEARCH_THRESHOLD = 50;

    let open = $state(false);
    let query = $state('');
    let inputEl = $state<HTMLInputElement | undefined>(undefined);
    let listEl = $state<HTMLDivElement | undefined>(undefined);
    let containerEl = $state<HTMLDivElement | undefined>(undefined);

    let totalCount = $derived(groups.reduce((n, g) => n + g.models.length, 0));
    let showSearch = $derived(totalCount > SEARCH_THRESHOLD);

    let currentLabel = $derived.by(() => {
        for (const g of groups) {
            const m = g.models.find((mm) => mm.id === value);
            if (m) return m.name;
        }
        return totalCount === 0 ? emptyLabel : value;
    });

    type Row =
        | { kind: 'header'; label: string; pinned: boolean }
        | {
              kind: 'item';
              model: ModelOption;
          };

    let rows = $derived.by(() => {
        const q = query.trim().toLowerCase();
        const out: Row[] = [];
        for (const g of groups) {
            const matches = q
                ? g.models.filter(
                      (m) =>
                          m.name.toLowerCase().includes(q) ||
                          m.id.toLowerCase().includes(q) ||
                          (m.vendor?.toLowerCase().includes(q) ?? false)
                  )
                : g.models;
            if (matches.length === 0) continue;
            if (groups.length > 1)
                out.push({
                    kind: 'header',
                    label: g.label,
                    pinned: !!g.pinned,
                });
            for (const m of matches) {
                out.push({
                    kind: 'item',
                    model: m,
                });
            }
        }
        return out;
    });

    function openPopover() {
        if (disabled || totalCount === 0) return;
        open = true;
        query = '';
        queueMicrotask(() => {
            if (showSearch) inputEl?.focus();
            scrollSelectedIntoView();
        });
    }

    function close() {
        open = false;
        query = '';
    }

    function togglePopover() {
        if (open) {
            close();
            return;
        }
        openPopover();
    }

    function pick(model: ModelOption) {
        value = model.id;
        onchange?.(model.id);
        close();
    }

    function scrollSelectedIntoView() {
        const buttons =
            listEl?.querySelectorAll<HTMLButtonElement>('[data-model-id]');
        const selected = Array.from(buttons ?? []).find(
            (button) => button.dataset.modelId === value
        );
        selected?.scrollIntoView({ block: 'nearest' });
    }

    function onDocumentMousedown(e: MouseEvent) {
        if (!open) return;
        if (containerEl && !containerEl.contains(e.target as Node)) close();
    }

    const triggerClass =
        'w-full flex items-center justify-between gap-2 pl-2.5 pr-8 py-[9px] bg-canvas border border-border rounded-lg text-fg font-sans text-sm cursor-pointer text-left transition-[border-color] duration-150 hover:border-accent-3-fg focus:outline-none focus:border-accent-3-fg disabled:opacity-50 disabled:cursor-not-allowed';
</script>

<svelte:document onmousedown={onDocumentMousedown} />

<div bind:this={containerEl} class="relative">
    <button
        type="button"
        class={triggerClass}
        disabled={disabled || totalCount === 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        onclick={togglePopover}
    >
        <span
            class={totalCount === 0
                ? 'min-w-0 whitespace-normal leading-snug'
                : 'truncate'}>{currentLabel}</span
        >
        <Icon name="chevron-down" size={12} class="select-arrow" />
    </button>

    {#if open}
        <div
            class="model-picker-popover absolute left-0 right-0 top-[calc(100%+4px)] z-30 flex flex-col bg-canvas border border-border rounded-lg shadow-[0_8px_24px_oklch(0%_0_0/15%)] overflow-hidden"
        >
            {#if showSearch}
                <div class="p-2 border-b border-border">
                    <input
                        bind:this={inputEl}
                        bind:value={query}
                        type="text"
                        placeholder="Search models..."
                        class="w-full px-2 py-1.5 bg-surface-raised border border-border rounded-md text-sm text-fg outline-none focus:border-accent-3-fg placeholder:text-fg-muted"
                    />
                </div>
            {/if}
            <div
                bind:this={listEl}
                role="listbox"
                class="thin-scrollbar max-h-72 overflow-y-auto outline-none"
            >
                {#if rows.length === 0}
                    <div class="px-3 py-4 text-sm text-fg-muted text-center">
                        No models found
                    </div>
                {:else}
                    {#each rows as row (row.kind === 'item' ? row.model.id : `header:${row.pinned ? '~' : ''}${row.label}`)}
                        {#if row.kind === 'header'}
                            <div
                                class="flex items-center gap-1 px-2.5 pt-2 pb-1 text-[0.6875rem] font-bold text-fg-muted uppercase tracking-wider"
                            >
                                {#if row.pinned}
                                    <Icon name="star" fill="currentColor" />
                                {/if}
                                {row.label}
                            </div>
                        {:else}
                            <button
                                type="button"
                                role="option"
                                aria-selected={row.model.id === value}
                                data-model-id={row.model.id}
                                class={[
                                    'w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-left text-sm cursor-pointer border-0 bg-transparent text-fg',
                                    'hover:bg-surface-raised',
                                    row.model.id === value && 'font-medium',
                                ]}
                                onclick={() => pick(row.model)}
                            >
                                <span class="truncate">{row.model.name}</span>
                                {#if row.model.id === value}
                                    <Icon
                                        name="check"
                                        size={14}
                                        class="shrink-0 text-accent-3-fg"
                                    />
                                {/if}
                            </button>
                        {/if}
                    {/each}
                {/if}
            </div>
        </div>
    {/if}
</div>

<style>
    .thin-scrollbar::-webkit-scrollbar {
        width: 3px;
    }
    .thin-scrollbar::-webkit-scrollbar-track {
        background: transparent;
    }
    .thin-scrollbar::-webkit-scrollbar-thumb {
        background-color: var(--color-border);
        border-radius: 3px;
    }
</style>
