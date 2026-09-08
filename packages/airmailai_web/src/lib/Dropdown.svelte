<script module lang="ts">
    export interface DropdownOption<Value extends string = string> {
        id: Value;
        name: string;
        searchText?: string;
        fontFamily?: string;
    }

    export interface DropdownGroup<Value extends string = string> {
        label: string;
        pinned?: boolean;
        options: readonly DropdownOption<Value>[];
    }
</script>

<script lang="ts" generics="Value extends string">
    import { tick } from 'svelte';
    import Icon from './Icon.svelte';

    let {
        id,
        options = [],
        groups,
        value = $bindable(),
        onchange,
        disabled = false,
        fullWidth = false,
        emptyLabel = 'No options available',
        searchPlaceholder = 'Search...',
        emptySearchLabel = 'No options found',
        searchable = false,
    }: {
        id: string;
        options?: readonly DropdownOption<Value>[];
        groups?: readonly DropdownGroup<Value>[];
        value: Value;
        onchange?: (value: Value) => void;
        disabled?: boolean;
        fullWidth?: boolean;
        emptyLabel?: string;
        searchPlaceholder?: string;
        emptySearchLabel?: string;
        searchable?: boolean;
    } = $props();

    let open = $state(false);
    let query = $state('');
    let activeIndex = $state(-1);
    let triggerEl: HTMLButtonElement;
    let listEl = $state<HTMLDivElement>();
    let inputEl = $state<HTMLInputElement>();
    let menuEl: HTMLDivElement;
    let position = $state({ left: 0, top: 0, minWidth: 0, maxHeight: 0 });
    let typeahead = '';
    let lastTypedAt = 0;

    const listId = $derived(`${id}-listbox`);
    const optionGroups = $derived(groups ?? [{ label: '', options }]);
    const allOptions = $derived(optionGroups.flatMap((group) => group.options));
    const currentOption = $derived(
        allOptions.find((option) => option.id === value)
    );
    const currentLabel = $derived(
        currentOption?.name ?? (allOptions.length === 0 ? emptyLabel : value)
    );

    type Row =
        | { kind: 'header'; label: string; pinned: boolean }
        | { kind: 'item'; option: DropdownOption<Value> };

    const rows = $derived.by(() => {
        const q = query.trim().toLowerCase();
        const result: Row[] = [];
        for (const group of optionGroups) {
            const matches = group.options.filter(
                (option) =>
                    !q ||
                    `${option.name} ${option.id} ${option.searchText ?? ''}`
                        .toLowerCase()
                        .includes(q)
            );
            if (matches.length === 0) continue;
            if (optionGroups.length > 1) {
                result.push({
                    kind: 'header',
                    label: group.label,
                    pinned: !!group.pinned,
                });
            }
            for (const option of matches) result.push({ kind: 'item', option });
        }
        return result;
    });
    const activeDescId = $derived(
        rows[activeIndex]?.kind === 'item'
            ? `${id}-option-${activeIndex}`
            : undefined
    );

    function itemIndexFrom(start: number, direction: 1 | -1): number {
        for (let i = start; i >= 0 && i < rows.length; i += direction) {
            if (rows[i].kind === 'item') return i;
        }
        return -1;
    }

    function scrollActiveIntoView() {
        if (activeDescId)
            document
                .getElementById(activeDescId)
                ?.scrollIntoView({ block: 'nearest' });
    }

    function setActive(index: number) {
        if (index === -1) return;
        activeIndex = index;
        void tick().then(scrollActiveIntoView);
    }

    function moveActive(direction: 1 | -1) {
        const start =
            activeIndex === -1
                ? direction === 1
                    ? 0
                    : rows.length - 1
                : activeIndex + direction;
        setActive(itemIndexFrom(start, direction));
    }

    function close(restoreFocus = false) {
        open = false;
        query = '';
        activeIndex = -1;
        typeahead = '';
        if (restoreFocus) triggerEl.focus();
    }

    function openMenu() {
        if (disabled || allOptions.length === 0) return;
        query = '';
        const selected = rows.findIndex(
            (row) => row.kind === 'item' && row.option.id === value
        );
        activeIndex = selected === -1 ? itemIndexFrom(0, 1) : selected;
        open = true;
    }

    function positionMenu() {
        const rect = triggerEl.getBoundingClientRect();
        const margin = 8;
        const gap = 4;
        const maxWidth = window.innerWidth - margin * 2;
        const minWidth = Math.min(rect.width, maxWidth);
        const width = Math.min(
            Math.max(minWidth, menuEl.getBoundingClientRect().width),
            maxWidth
        );
        const below = Math.max(
            0,
            window.innerHeight - rect.bottom - gap - margin
        );
        const above = Math.max(0, rect.top - gap - margin);
        const height = Math.min(menuEl.scrollHeight + 2, 360);
        const upwards = below < height && above > below;
        const maxHeight = Math.min(360, upwards ? above : below);
        position = {
            left: Math.max(
                margin,
                Math.min(rect.left, window.innerWidth - width - margin)
            ),
            top: upwards
                ? rect.top - gap - Math.min(height, maxHeight)
                : rect.bottom + gap,
            minWidth,
            maxHeight,
        };
    }

    function attachMenu(node: HTMLDivElement) {
        menuEl = node;
        node.showPopover();
        positionMenu();
        void tick().then(() => {
            if (!open) return;
            (searchable ? inputEl : listEl)?.focus({ preventScroll: true });
            scrollActiveIntoView();
        });
        const observer = new ResizeObserver(positionMenu);
        observer.observe(triggerEl);
        if (listEl) observer.observe(listEl);
        const onScroll = (event: Event) => {
            if (event.target instanceof Node && node.contains(event.target))
                return;
            close();
        };
        document.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', positionMenu);
        return () => {
            observer.disconnect();
            document.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('resize', positionMenu);
        };
    }

    function pick(option: DropdownOption<Value>) {
        value = option.id;
        onchange?.(option.id);
        close(true);
    }

    function onTriggerKeydown(event: KeyboardEvent) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            openMenu();
        }
    }

    function onListKeydown(event: KeyboardEvent) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            moveActive(event.key === 'ArrowDown' ? 1 : -1);
        } else if (
            !searchable &&
            (event.key === 'Home' || event.key === 'End')
        ) {
            event.preventDefault();
            setActive(
                event.key === 'Home'
                    ? itemIndexFrom(0, 1)
                    : itemIndexFrom(rows.length - 1, -1)
            );
        } else if (
            event.key === 'Enter' ||
            (event.key === ' ' && !searchable)
        ) {
            event.preventDefault();
            const row = rows[activeIndex];
            if (row?.kind === 'item') pick(row.option);
        } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close(true);
        } else if (event.key === 'Tab') {
            close(true);
        } else if (
            !searchable &&
            event.key.length === 1 &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey
        ) {
            event.preventDefault();
            const now = Date.now();
            typeahead =
                now - lastTypedAt > 700 ? event.key : typeahead + event.key;
            lastTypedAt = now;
            const q = typeahead.toLowerCase();
            const prefix = [...q].every((character) => character === q[0])
                ? q[0]
                : q;
            for (let offset = 1; offset <= rows.length; offset++) {
                const index = (activeIndex + offset) % rows.length;
                const row = rows[index];
                if (
                    row.kind === 'item' &&
                    row.option.name.toLowerCase().startsWith(prefix)
                ) {
                    setActive(index);
                    break;
                }
            }
        }
    }

    function onOutsideInteraction(event: Event) {
        if (!open || !(event.target instanceof Node)) return;
        if (
            !triggerEl.contains(event.target) &&
            !menuEl?.contains(event.target)
        )
            close();
    }
</script>

<svelte:document
    onpointerdown={onOutsideInteraction}
    onfocusin={onOutsideInteraction}
/>

<button
    bind:this={triggerEl}
    {id}
    type="button"
    class={[
        'dropdown-trigger flex min-w-0 max-w-full items-center justify-between gap-2 px-2.5 py-2.25 bg-canvas border border-border rounded-lg text-fg font-sans text-sm cursor-pointer text-left transition-[border-color] duration-150 hover:border-accent-3-fg focus:outline-none focus:border-accent-3-fg disabled:opacity-50 disabled:cursor-not-allowed',
        fullWidth && 'w-full',
    ]}
    disabled={disabled || allOptions.length === 0}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-controls={open ? listId : undefined}
    onclick={() => (open ? close() : openMenu())}
    onkeydown={onTriggerKeydown}
>
    <span
        class="min-w-0 whitespace-normal leading-snug"
        style:font-family={currentOption?.fontFamily}>{currentLabel}</span
    >
    <Icon name="chevron-down" size={12} class="shrink-0" />
</button>

{#if open}
    <div
        {@attach attachMenu}
        popover="manual"
        class="dropdown-menu m-0 p-0 fixed flex flex-col bg-canvas border border-border rounded-lg text-fg font-sans shadow-[0_8px_24px_oklch(0%_0_0/15%)] overflow-hidden"
        style:left="{position.left}px"
        style:top="{position.top}px"
        style:width="max-content"
        style:min-width="{position.minWidth}px"
        style:max-width="calc(100vw - 16px)"
        style:max-height={position.maxHeight
            ? `${position.maxHeight}px`
            : '360px'}
    >
        {#if searchable}
            <div class="shrink-0 p-2 border-b border-border">
                <input
                    bind:this={inputEl}
                    value={query}
                    type="text"
                    role="combobox"
                    placeholder={searchPlaceholder}
                    aria-label={searchPlaceholder}
                    class="w-full px-2 py-1.5 bg-surface-raised border border-border rounded-md text-sm text-fg outline-none focus:border-accent-3-fg placeholder:text-fg-muted"
                    aria-expanded="true"
                    aria-autocomplete="list"
                    aria-controls={listId}
                    aria-activedescendant={activeDescId}
                    oninput={(event) => {
                        query = event.currentTarget.value;
                        activeIndex = itemIndexFrom(0, 1);
                        void tick().then(scrollActiveIntoView);
                    }}
                    onkeydown={onListKeydown}
                />
            </div>
        {/if}
        <div
            bind:this={listEl}
            id={listId}
            role="listbox"
            tabindex="-1"
            class="thin-scrollbar min-h-0 overflow-y-auto outline-none py-1"
            aria-labelledby={id}
            aria-activedescendant={activeDescId}
            onkeydown={onListKeydown}
        >
            {#if rows.length === 0}
                <div class="px-3 py-4 text-sm text-fg-muted text-center">
                    {emptySearchLabel}
                </div>
            {:else}
                {#each rows as row, i (row.kind === 'item' ? row.option.id : `header:${row.pinned ? '~' : ''}${row.label}`)}
                    {#if row.kind === 'header'}
                        <div
                            class="flex items-center gap-1 px-2.5 pt-2 pb-1 text-[0.6875rem] font-bold text-fg-muted uppercase tracking-wider"
                        >
                            {#if row.pinned}<Icon
                                    name="star"
                                    fill="currentColor"
                                />{/if}
                            {row.label}
                        </div>
                    {:else}
                        <button
                            type="button"
                            role="option"
                            tabindex="-1"
                            id="{id}-option-{i}"
                            aria-selected={row.option.id === value}
                            data-option-id={row.option.id}
                            data-active={i === activeIndex}
                            class={[
                                'dropdown-option w-full flex items-center justify-between gap-2 px-2.5 py-2 text-left text-sm cursor-pointer border-0 text-fg',
                                row.option.id === value && 'font-medium',
                            ]}
                            onclick={() => pick(row.option)}
                            onpointermove={() => (activeIndex = i)}
                        >
                            <span
                                class="min-w-0 whitespace-normal"
                                style:font-family={row.option.fontFamily}
                                >{row.option.name}</span
                            >
                            <span class="w-3.5 shrink-0 text-accent-3-fg">
                                {#if row.option.id === value}<Icon
                                        name="check"
                                        size={14}
                                    />{/if}
                            </span>
                        </button>
                    {/if}
                {/each}
            {/if}
        </div>
    </div>
{/if}

<style>
    .dropdown-menu {
        inset: auto;
    }

    .dropdown-option {
        background-color: transparent;
    }

    .dropdown-option[data-active='true'] {
        background-color: var(--color-surface-raised);
    }
</style>
