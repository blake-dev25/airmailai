<script lang="ts">
    import type { ModelOption } from './constants';
    import Icon from './Icon.svelte';

    let {
        groups,
        value = $bindable(),
        onchange,
        disabled = false,
        emptyLabel = 'Loading models...',
    }: {
        groups: Array<{ label: string; models: ModelOption[] }>;
        value: string;
        onchange?: (id: string) => void;
        disabled?: boolean;
        emptyLabel?: string;
    } = $props();

    const SEARCH_THRESHOLD = 50;

    let open = $state(false);
    let query = $state('');
    let activeIndex = $state(0);
    let inputEl = $state<HTMLInputElement | undefined>(undefined);
    let listEl = $state<HTMLDivElement | undefined>(undefined);
    let containerEl = $state<HTMLDivElement | undefined>(undefined);

    let totalCount = $derived(
        groups.reduce((n, g) => n + g.models.length, 0),
    );
    let showSearch = $derived(totalCount > SEARCH_THRESHOLD);

    let currentLabel = $derived.by(() => {
        for (const g of groups) {
            const m = g.models.find((mm) => mm.id === value);
            if (m) return m.name;
        }
        return totalCount === 0 ? emptyLabel : value;
    });

    // Filtered + flattened view used for both rendering and keyboard nav.
    // Each entry is either a group header (no model) or a model item.
    type Row =
        | { kind: 'header'; label: string }
        | {
              kind: 'item';
              model: ModelOption;
              flatIndex: number;
              groupLabel: string;
          };

    let rows = $derived.by(() => {
        const q = query.trim().toLowerCase();
        const out: Row[] = [];
        let flat = 0;
        for (const g of groups) {
            const matches = q
                ? g.models.filter(
                      (m) =>
                          m.name.toLowerCase().includes(q) ||
                          m.id.toLowerCase().includes(q) ||
                          (m.vendor?.toLowerCase().includes(q) ?? false),
                  )
                : g.models;
            if (matches.length === 0) continue;
            // Hide group headers when there's a single group — the trigger
            // already implies the source. Keep them for multi-group views.
            if (groups.length > 1) out.push({ kind: 'header', label: g.label });
            for (const m of matches) {
                out.push({
                    kind: 'item',
                    model: m,
                    flatIndex: flat,
                    groupLabel: g.label,
                });
                flat++;
            }
        }
        return out;
    });

    let itemCount = $derived(rows.filter((r) => r.kind === 'item').length);

    function openPopover() {
        if (disabled || totalCount === 0) return;
        open = true;
        query = '';
        // Land on the currently-selected row, or 0 if not in the filtered set.
        let idx = 0;
        for (const r of rows) {
            if (r.kind === 'item' && r.model.id === value) {
                idx = r.flatIndex;
                break;
            }
        }
        activeIndex = idx;
        queueMicrotask(() => {
            if (showSearch) inputEl?.focus();
            else listEl?.focus();
            scrollActiveIntoView();
        });
    }

    function close() {
        open = false;
        query = '';
    }

    function pick(model: ModelOption) {
        value = model.id;
        onchange?.(model.id);
        close();
    }

    function scrollActiveIntoView() {
        const el = listEl?.querySelector(
            `[data-flat-index="${activeIndex}"]`,
        ) as HTMLElement | null;
        el?.scrollIntoView({ block: 'nearest' });
    }

    function move(delta: number) {
        if (itemCount === 0) return;
        activeIndex = (activeIndex + delta + itemCount) % itemCount;
        queueMicrotask(scrollActiveIntoView);
    }

    function onKeydown(e: KeyboardEvent) {
        if (!open) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            close();
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            move(1);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            move(-1);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const row = rows.find(
                (r) => r.kind === 'item' && r.flatIndex === activeIndex,
            );
            if (row?.kind === 'item') pick(row.model);
        }
    }

    function onDocumentMousedown(e: MouseEvent) {
        if (!open) return;
        if (containerEl && !containerEl.contains(e.target as Node)) close();
    }

    $effect(() => {
        if (!open) return;
        document.addEventListener('mousedown', onDocumentMousedown);
        return () =>
            document.removeEventListener('mousedown', onDocumentMousedown);
    });

    // When the filtered list shrinks past activeIndex (e.g. user types), snap
    // back to the top so we don't leave a stale highlight off-list.
    $effect(() => {
        if (activeIndex >= itemCount) activeIndex = 0;
    });

    const triggerClass =
        'w-full flex items-center justify-between gap-2 pl-2.5 pr-8 py-[9px] bg-canvas border border-border rounded-lg text-fg font-sans text-sm cursor-pointer text-left transition-[border-color] duration-150 hover:border-accent-3-fg focus:outline-none focus:border-accent-3-fg disabled:opacity-50 disabled:cursor-not-allowed';
</script>

<!-- The wrapper catches keydown while the popover is open so any focused
     child (trigger button, search input, list items) routes keys to the
     same handler. The interactive semantics live on the inner button. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div bind:this={containerEl} class="relative" onkeydown={onKeydown}>
    <button
        type="button"
        class={triggerClass}
        disabled={disabled || totalCount === 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        onclick={openPopover}
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
                tabindex="-1"
                class="thin-scrollbar max-h-72 overflow-y-auto outline-none"
            >
                {#if rows.length === 0}
                    <div class="px-3 py-4 text-sm text-fg-muted text-center">
                        No models found
                    </div>
                {:else}
                    {#each rows as row}
                        {#if row.kind === 'header'}
                            <div
                                class="px-2.5 pt-2 pb-1 text-[0.6875rem] font-semibold text-fg-muted uppercase tracking-wider"
                            >
                                {row.label}
                            </div>
                        {:else}
                            <button
                                type="button"
                                role="option"
                                aria-selected={row.model.id === value}
                                data-flat-index={row.flatIndex}
                                class={[
                                    'w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-left text-sm cursor-pointer border-0 bg-transparent text-fg',
                                    row.flatIndex === activeIndex &&
                                        'bg-surface-raised',
                                    row.model.id === value && 'font-medium',
                                ]}
                                onmouseenter={() =>
                                    (activeIndex = row.flatIndex)}
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
