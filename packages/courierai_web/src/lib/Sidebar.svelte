<script lang="ts">
    import { VList } from 'virtua/svelte';
    import { appLifecycle } from './appLifecycle.svelte';
    import { chatStore } from './chatStore.svelte';
    import Icon from './Icon.svelte';
    import SettingsPopover from './SettingsPopover.svelte';
    import type { Chat } from './types';

    let showSettings = $state(false);
    let historyHovered = $state(false);
    let searchValue = $state('');
    let listRef = $state<VList<Chat> | undefined>(undefined);

    // Auto-load more when within ~1.5 viewport heights of the bottom — hides
    // the request behind the user's existing scroll momentum.
    function maybeLoadMore() {
        if (!listRef || !chatStore.hasMoreChats || chatStore.isLoadingMore)
            return;
        const offset = listRef.getScrollOffset();
        const total = listRef.getScrollSize();
        const viewport = listRef.getViewportSize();
        if (total - offset - viewport < viewport * 1.5) chatStore.loadMore();
    }

    function highlightSnippet(raw: string, query: string): string {
        const q = query.toLowerCase();
        const idx = raw.toLowerCase().indexOf(q);
        const esc = (s: string) =>
            s
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
        if (idx === -1) return esc(raw);
        return (
            esc(raw.slice(0, idx)) +
            `<mark class="search-mark">${esc(raw.slice(idx, idx + query.length))}</mark>` +
            esc(raw.slice(idx + query.length))
        );
    }

    // Chat context menu
    let openMenuChat = $state<Chat | null>(null);
    let menuPos = $state({ top: 0, left: 0 });
    let renamingChatId = $state<string | null>(null);
    let renameValue = $state('');

    function openMenu(e: MouseEvent, chat: Chat) {
        e.stopPropagation();
        if (openMenuChat?.id === chat.id) {
            openMenuChat = null;
            return;
        }
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        menuPos = { top: rect.bottom + 4, left: rect.right - 140 };
        openMenuChat = chat;
    }

    function closeMenu() {
        openMenuChat = null;
    }

    function startRename(chatId: string, currentTitle: string) {
        renamingChatId = chatId;
        renameValue = currentTitle;
        openMenuChat = null;
    }

    function commitRename() {
        if (renamingChatId && renameValue.trim()) {
            chatStore.rename(renamingChatId, renameValue.trim());
        }
        renamingChatId = null;
        renameValue = '';
    }

    // Airmail diagonal stripe decoration — reversed direction (\), with beige gaps
    const stripeH = 20;
    const stripeW = 40; // width of each colored stripe
    const gap = 40; // beige gap (equal width to colored stripes)
    const pitch = stripeW + gap; // 80px per stripe slot
    const sidebarW = 256;
    const startI = -Math.ceil(stripeH / pitch) - 1;
    const endI = Math.ceil(sidebarW / pitch) + 1;
    const stripes = Array.from({ length: endI - startI + 1 }, (_, idx) => {
        const i = startI + idx;
        const x = i * pitch - 22; // offset so leftmost stripe is clipped by left edge
        // Reversed direction: top edge is shifted right by stripeH, bottom is at x
        return {
            points: `${x + stripeH},0 ${x + stripeH + stripeW},0 ${x + stripeW},${stripeH} ${x},${stripeH}`,
            red: i % 2 === 0,
        };
    });

    const chatItemClass =
        'flex-1 min-w-0 px-2.5 py-2 bg-transparent border-0 rounded-md cursor-pointer text-left';
    const chatTitleClass =
        'block text-sm text-fg overflow-hidden text-ellipsis whitespace-nowrap';
</script>

<svelte:window onclick={() => closeMenu()} />

<aside
    class="sidebar w-64 shrink-0 flex flex-col bg-canvas border-r border-border overflow-hidden select-none [&_input]:select-text"
>
    <svg
        width={sidebarW}
        height={stripeH}
        viewBox="0 0 {sidebarW} {stripeH}"
        class="block shrink-0"
        aria-hidden="true"
    >
        <defs>
            <clipPath id="stripe-clip">
                <rect width={sidebarW} height={stripeH} />
            </clipPath>
        </defs>
        <g clip-path="url(#stripe-clip)">
            <rect
                width={sidebarW}
                height={stripeH}
                fill="var(--color-canvas)"
            />
            <!-- eslint-disable-next-line svelte/require-each-key -->
            {#each stripes as stripe}
                <polygon
                    points={stripe.points}
                    fill={stripe.red
                        ? 'var(--color-accent-bg)'
                        : 'var(--color-accent-2-bg)'}
                />
            {/each}
        </g>
    </svg>

    <div
        class="flex shrink-0 items-center justify-center gap-2.5 px-4 py-4.5 text-fg border-b border-border"
    >
        <Icon name="mail" size={32} class="logo-mail" />
        <span
            class="text-[34px] font-semibold tracking-[-0.02em] font-[Courier,monospace]"
            >CourierAI</span
        >
    </div>

    <div class="flex shrink-0 flex-col gap-1.5 p-3 border-b border-border">
        <div
            class="flex items-center gap-2 w-full px-2.5 py-1.75 bg-canvas border border-border rounded-lg box-border opacity-45 transition-[opacity,border-color] duration-150 focus-within:opacity-100 focus-within:border-fg-muted"
        >
            <Icon name="search" class="search-icon" />
            <input
                class="flex-1 bg-transparent border-0 outline-none font-sans text-sm text-fg min-w-0 placeholder:text-fg-muted [&::-webkit-search-cancel-button]:appearance-none"
                type="search"
                placeholder="Search"
                bind:value={searchValue}
                onkeydown={(e) => {
                    if (e.key === 'Enter' && searchValue.trim())
                        chatStore.search(searchValue.trim());
                    if (e.key === 'Escape') {
                        searchValue = '';
                        chatStore.clearSearch();
                    }
                }}
                oninput={() => {
                    if (!searchValue) chatStore.clearSearch();
                }}
            />
            {#if searchValue}
                <button
                    type="button"
                    class="shrink-0 flex items-center justify-center w-4 h-4 p-0 bg-transparent border-0 rounded-[3px] text-fg-muted cursor-pointer opacity-60 transition-opacity duration-100 hover:opacity-100"
                    onclick={() => {
                        searchValue = '';
                        chatStore.clearSearch();
                    }}
                    aria-label="Clear search"
                >
                    <Icon name="close" />
                </button>
            {/if}
        </div>
        <button
            type="button"
            class="flex items-center justify-center gap-2 w-full px-3 py-2.25 bg-accent-bg text-on-accent-bg border-0 rounded-lg text-sm font-medium cursor-pointer transition-[background-color,color] duration-150 hover:bg-accent-bg-hover hover:text-on-accent-bg-hover"
            onclick={() => chatStore.newChat()}
        >
            <Icon name="plus" />
            New Chat
        </button>
    </div>

    {#if chatStore.searchResults !== null}
        <nav
            class={[
                'history search-mode flex-1 min-h-0 overflow-y-auto px-2 py-1',
                historyHovered && 'hovered',
            ]}
            aria-label="Search results"
            onmouseenter={() => (historyHovered = true)}
            onmouseleave={() => (historyHovered = false)}
        >
            <p
                class="px-2.5 pt-2.5 pb-1 text-[0.6875rem] font-semibold tracking-[0.06em] uppercase text-fg-muted m-0"
            >
                {chatStore.searchResults.length} result{chatStore.searchResults
                    .length === 1
                    ? ''
                    : 's'}
            </p>
            {#if chatStore.searchResults.length === 0}
                <p class="px-2 pt-2 pb-5 text-sm text-fg text-center m-0">
                    No matches found
                </p>
            {:else}
                {#each chatStore.searchResults as result (result.id)}
                    <div
                        class={[
                            'group flex items-center rounded-md mb-px transition-[background-color] duration-100 hover:bg-surface-raised',
                            result.id === chatStore.activeChatId &&
                                'bg-surface-raised',
                        ]}
                    >
                        <button
                            type="button"
                            class={chatItemClass}
                            onclick={() =>
                                chatStore.activate(
                                    result.id,
                                    result.matchIndex
                                )}
                            title={result.title}
                        >
                            <span
                                class={[
                                    chatTitleClass,
                                    result.id === chatStore.activeChatId &&
                                        'text-accent-fg',
                                ]}
                            >
                                <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                                {@html highlightSnippet(
                                    result.title,
                                    chatStore.searchQuery
                                )}
                            </span>
                            {#if result.snippet}
                                <span
                                    class="block text-[0.6875rem] text-fg-muted overflow-hidden text-ellipsis whitespace-nowrap mt-px"
                                >
                                    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                                    {@html highlightSnippet(
                                        result.snippet,
                                        chatStore.searchQuery
                                    )}
                                </span>
                            {/if}
                        </button>
                    </div>
                {/each}
            {/if}
        </nav>
    {:else}
        <nav
            class={[
                'history chat-mode flex-1 min-h-0 px-2 py-1 flex flex-col',
                historyHovered && 'hovered',
            ]}
            aria-label="Chat history"
            onmouseenter={() => (historyHovered = true)}
            onmouseleave={() => (historyHovered = false)}
        >
            <p
                class="px-2.5 pt-2.5 pb-1 text-[0.6875rem] font-semibold tracking-[0.06em] uppercase text-fg-muted m-0"
            >
                Recent Chats
            </p>
            {#if !appLifecycle.initialized}
                <!-- Blank until extension responds — avoids "No conversations yet" flash on refresh. -->
            {:else if chatStore.chats.length === 0}
                <p class="px-2 pt-2 pb-5 text-sm text-fg text-center m-0">
                    No conversations yet
                </p>
            {:else}
                <div class="flex-1 min-h-0">
                    <VList
                        bind:this={listRef}
                        data={chatStore.chats}
                        getKey={(c) => c.id}
                        itemSize={32}
                        onscroll={maybeLoadMore}
                        class="chat-vlist"
                    >
                        {#snippet children(chat: Chat)}
                            <div
                                class={[
                                    'group flex items-center rounded-md mb-px transition-[background-color] duration-100 hover:bg-surface-raised',
                                    chat.id === chatStore.activeChatId &&
                                        'bg-surface-raised',
                                ]}
                            >
                                {#if renamingChatId === chat.id}
                                    <input
                                        class="flex-1 min-w-0 px-2.5 py-1.5 bg-canvas border border-accent-fg rounded-md outline-none font-sans text-sm text-fg"
                                        {@attach (node: HTMLInputElement) => {
                                            node.focus();
                                            node.select();
                                        }}
                                        bind:value={renameValue}
                                        onblur={commitRename}
                                        onclick={(e) => e.stopPropagation()}
                                        onkeydown={(e) => {
                                            if (e.key === 'Enter') {
                                                e.preventDefault();
                                                commitRename();
                                            }
                                            if (e.key === 'Escape') {
                                                renamingChatId = null;
                                                renameValue = '';
                                            }
                                        }}
                                    />
                                {:else}
                                    <button
                                        type="button"
                                        class={chatItemClass}
                                        onclick={() =>
                                            chatStore.activate(chat.id)}
                                        title={chat.title}
                                    >
                                        <span
                                            class={[
                                                chatTitleClass,
                                                chat.id ===
                                                    chatStore.activeChatId &&
                                                    'text-accent-fg',
                                            ]}>{chat.title}</span
                                        >
                                    </button>
                                {/if}
                                {#if chatStore.allStreamingChatIds.has(chat.id) && chat.id !== chatStore.activeChatId}
                                    <span
                                        class="shrink-0 flex items-center justify-center w-5 h-5 mr-0.5 text-xs font-bold text-fg-muted"
                                        aria-label="Streaming"
                                    >
                                        <Icon name="spinner" />
                                    </span>
                                {:else if chatStore.chatErrors[chat.id]}
                                    <span
                                        class="shrink-0 flex items-center justify-center w-5 h-5 mr-0.5 text-xs font-bold text-accent-fg"
                                        aria-label="Error">!</span
                                    >
                                {/if}
                                <button
                                    type="button"
                                    class={[
                                        'menu-btn shrink-0 flex items-center justify-center w-5 h-5 p-0 mr-1.5 bg-transparent border-0 rounded cursor-pointer text-fg-muted opacity-0 transition-[opacity,color,background-color] duration-100 group-hover:opacity-100 hover:text-accent-fg hover:bg-surface-sunken',
                                        openMenuChat?.id === chat.id &&
                                            'opacity-100! text-accent-fg! bg-surface-sunken!',
                                    ]}
                                    aria-label="Chat options"
                                    onclick={(e) => openMenu(e, chat)}
                                >
                                    <Icon name="settings" size={13} />
                                </button>
                            </div>
                        {/snippet}
                    </VList>
                </div>
            {/if}
        </nav>
    {/if}

    <div class="shrink-0 px-3 py-3.25 border-t border-border">
        <button
            type="button"
            class={[
                'flex items-center gap-2 w-full h-[calc(20px+0.875rem*1.5)] px-2.5 bg-transparent border-0 rounded-md text-sm text-fg cursor-pointer transition-[background-color,color] duration-100 hover:bg-surface-raised',
                showSettings && 'bg-surface-raised text-accent-fg',
            ]}
            onclick={() => {
                if (chatStore.demoMode) {
                    appLifecycle.requestExtension();
                    return;
                }
                showSettings = !showSettings;
            }}
        >
            <Icon name="settings" />
            Settings
        </button>
    </div>
</aside>

{#if openMenuChat}
    <div
        class="fixed z-200 min-w-35 flex flex-col bg-surface-raised border border-border rounded-lg shadow-[0_4px_16px_rgba(0,0,0,0.18)] p-1 select-none"
        style="top: {menuPos.top}px; left: {menuPos.left}px;"
    >
        <button
            type="button"
            class="flex items-center gap-2 w-full px-2.5 py-1.75 bg-transparent border-0 rounded text-sm font-sans text-fg cursor-pointer text-left transition-[background-color,color] duration-100 hover:bg-canvas"
            onclick={(e) => {
                e.stopPropagation();
                startRename(openMenuChat!.id, openMenuChat!.title);
            }}
        >
            <Icon name="edit" />
            Rename
        </button>
        <button
            type="button"
            class="flex items-center gap-2 w-full px-2.5 py-1.75 bg-transparent border-0 rounded text-sm font-sans text-fg cursor-pointer text-left transition-[background-color,color] duration-100 hover:bg-canvas"
            onclick={(e) => {
                e.stopPropagation();
                chatStore.export(openMenuChat!.id);
                closeMenu();
            }}
        >
            <Icon name="download" />
            Export
        </button>
        <div class="h-px bg-border my-0.75"></div>
        <button
            type="button"
            class="flex items-center gap-2 w-full px-2.5 py-1.75 bg-transparent border-0 rounded text-sm font-sans text-fg cursor-pointer text-left transition-[background-color,color] duration-100 hover:bg-canvas hover:text-accent-fg"
            onclick={(e) => {
                e.stopPropagation();
                chatStore.remove(openMenuChat!.id);
                closeMenu();
            }}
        >
            <Icon name="trash" />
            Delete
        </button>
    </div>
{/if}

{#if showSettings}
    <SettingsPopover onclose={() => (showSettings = false)} />
{/if}

<style>
    /* CSS islands — passed-through Icon classes + scrollbar pseudos with hover-driven visibility */

    :global(.search-icon) {
        color: var(--color-fg);
    }

    :global(.logo-mail) {
        transform: translateY(-2px);
    }

    /* Search-mode scrollbar — hidden until parent .history.hovered, then shows the thumb */
    .history.search-mode::-webkit-scrollbar {
        width: 3px;
    }
    .history.search-mode::-webkit-scrollbar-track {
        background: transparent;
    }
    .history.search-mode::-webkit-scrollbar-thumb {
        background-color: transparent;
        border-radius: 3px;
    }
    .history.search-mode.hovered::-webkit-scrollbar-thumb {
        background-color: var(--color-border);
    }

    /* Chat-mode scrollbar — same hover-reveal, but on the inner virtua list (passed via class) */
    :global(.chat-vlist::-webkit-scrollbar) {
        width: 3px;
    }
    :global(.chat-vlist::-webkit-scrollbar-track) {
        background: transparent;
    }
    :global(.chat-vlist::-webkit-scrollbar-thumb) {
        background-color: transparent;
        border-radius: 3px;
    }
    .history.chat-mode.hovered :global(.chat-vlist::-webkit-scrollbar-thumb) {
        background-color: var(--color-border);
    }

    /* Search-mark — applied to {@html}-injected markup, can't take utility classes */
    :global(.search-mark) {
        background-color: var(--color-accent-2-bg);
        color: var(--color-on-accent-2-bg);
        border-radius: 2px;
        padding: 0 1px;
    }
</style>
