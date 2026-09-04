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
    let activeIndex = $state(-1);
    let inputEl = $state<HTMLInputElement | undefined>(undefined);
    let listEl = $state<HTMLDivElement | undefined>(undefined);
    let containerEl = $state<HTMLDivElement | undefined>(undefined);
    let triggerEl = $state<HTMLButtonElement | undefined>(undefined);

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

    let activeRow = $derived(rows[activeIndex]);
    let activeDescId = $derived(
        activeRow?.kind === 'item'
            ? `model-opt-${activeRow.model.id}`
            : undefined
    );

    function itemIndexFrom(start: number, dir: 1 | -1): number {
        for (let i = start; i >= 0 && i < rows.length; i += dir) {
            if (rows[i].kind === 'item') return i;
        }
        return -1;
    }

    function setActive(index: number) {
        activeIndex = index;
        const row = rows[index];
        if (row?.kind !== 'item') return;
        queueMicrotask(() => {
            listEl
                ?.querySelector(`[data-model-id="${CSS.escape(row.model.id)}"]`)
                ?.scrollIntoView({ block: 'nearest' });
        });
    }

    function moveActive(dir: 1 | -1) {
        const start =
            activeIndex === -1
                ? dir === 1
                    ? 0
                    : rows.length - 1
                : activeIndex + dir;
        const next = itemIndexFrom(start, dir);
        if (next !== -1) setActive(next);
    }

    function openPopover() {
        if (disabled || totalCount === 0) return;
        open = true;
        query = '';
        const selected = rows.findIndex(
            (r) => r.kind === 'item' && r.model.id === value
        );
        activeIndex = selected !== -1 ? selected : itemIndexFrom(0, 1);
        queueMicrotask(() => {
            if (showSearch) inputEl?.focus();
            else listEl?.focus();
            scrollSelectedIntoView();
        });
    }

    function close() {
        open = false;
        query = '';
        activeIndex = -1;
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
        triggerEl?.focus();
    }

    function onTriggerKeydown(e: KeyboardEvent) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!open) openPopover();
            else moveActive(e.key === 'ArrowDown' ? 1 : -1);
        } else if (e.key === 'Escape' && open) {
            e.preventDefault();
            close();
        }
    }

    function onListKeydown(e: KeyboardEvent) {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            moveActive(1);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            moveActive(-1);
        } else if (e.key === 'Home' && !showSearch) {
            e.preventDefault();
            setActive(itemIndexFrom(0, 1));
        } else if (e.key === 'End' && !showSearch) {
            e.preventDefault();
            setActive(itemIndexFrom(rows.length - 1, -1));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const row = rows[activeIndex];
            if (row?.kind === 'item') pick(row.model);
        } else if (e.key === 'Escape' || e.key === 'Tab') {
            e.preventDefault();
            close();
            triggerEl?.focus();
        }
    }

    function onQueryInput(e: Event) {
        query = (e.currentTarget as HTMLInputElement).value;
        activeIndex = itemIndexFrom(0, 1);
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
        bind:this={triggerEl}
        type="button"
        class={triggerClass}
        disabled={disabled || totalCount === 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        onclick={togglePopover}
        onkeydown={onTriggerKeydown}
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
                        value={query}
                        type="text"
                        role="combobox"
                        placeholder="Search models..."
                        class="w-full px-2 py-1.5 bg-surface-raised border border-border rounded-md text-sm text-fg outline-none focus:border-accent-3-fg placeholder:text-fg-muted"
                        aria-expanded="true"
                        aria-autocomplete="list"
                        aria-controls="model-picker-listbox"
                        aria-activedescendant={activeDescId}
                        oninput={onQueryInput}
                        onkeydown={onListKeydown}
                    />
                </div>
            {/if}
            <div
                bind:this={listEl}
                id="model-picker-listbox"
                role="listbox"
                tabindex="-1"
                class="thin-scrollbar max-h-72 overflow-y-auto outline-none"
                aria-activedescendant={activeDescId}
                onkeydown={onListKeydown}
            >
                {#if rows.length === 0}
                    <div class="px-3 py-4 text-sm text-fg-muted text-center">
                        No models found
                    </div>
                {:else}
                    {#each rows as row, i (row.kind === 'item' ? row.model.id : `header:${row.pinned ? '~' : ''}${row.label}`)}
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
                                id="model-opt-{row.model.id}"
                                aria-selected={row.model.id === value}
                                data-model-id={row.model.id}
                                class={[
                                    'w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-left text-sm cursor-pointer border-0 bg-transparent text-fg',
                                    i === activeIndex && 'bg-surface-raised',
                                    row.model.id === value && 'font-medium',
                                ]}
                                onclick={() => pick(row.model)}
                                onmouseenter={() => (activeIndex = i)}
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
