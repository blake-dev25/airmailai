<script lang="ts">
    import type { ModelTier } from './constants';
    import SettingsPopover from './SettingsPopover.svelte';

    interface Chat {
        id: string;
        title: string;
        messages: { role: string; content: string }[];
        createdAt: number;
    }

    let {
        chats,
        activeChatId,
        hasMoreChats,
        isLoadingMore,
        streamingChatIds,
        chatErrors,
        searchResults,
        searchQuery,
        demoMode = false,
        theme = $bindable(),
        fontSizeIndex = $bindable(),
        chatWidth = $bindable(),
        smoothTextMode = $bindable(),
        submitKeystroke = $bindable(),
        modelTier = $bindable(),
        onnewchat,
        onselectchat,
        ondeletechat,
        onrenamechat,
        onexportchat,
        onloadmore,
        onsearch,
        onclearsearch,
        onextensionneeded,
    }: {
        chats: Chat[];
        activeChatId: string | null;
        hasMoreChats: boolean;
        isLoadingMore: boolean;
        streamingChatIds: string[];
        chatErrors: Record<string, string>;
        searchResults:
            | {
                  id: string;
                  title: string;
                  snippet: string;
                  matchIndex: number | null;
              }[]
            | null;
        searchQuery: string;
        demoMode?: boolean;
        theme: string;
        fontSizeIndex: number;
        chatWidth: number;
        smoothTextMode:
            | 'smooth'
            | 'boost-on-complete'
            | 'dump-on-complete'
            | 'raw';
        submitKeystroke: 'enter' | 'ctrl+enter';
        modelTier: ModelTier;
        onnewchat: () => void;
        onselectchat: (id: string, matchIndex?: number | null) => void;
        ondeletechat: (id: string) => void;
        onrenamechat: (id: string, title: string) => void;
        onexportchat: (id: string) => void;
        onloadmore: () => void;
        onsearch: (query: string) => void;
        onclearsearch: () => void;
        onextensionneeded: () => void;
    } = $props();

    let showSettings = $state(false);
    let historyHovered = $state(false);
    let searchValue = $state('');

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
            onrenamechat(renamingChatId, renameValue.trim());
        }
        renamingChatId = null;
        renameValue = '';
    }

    function focusAndSelect(node: HTMLInputElement) {
        node.focus();
        node.select();
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
</script>

<svelte:window onclick={() => closeMenu()} />

<aside class="sidebar">
    <svg
        width={sidebarW}
        height={stripeH}
        viewBox="0 0 {sidebarW} {stripeH}"
        class="airmail-stripe"
        aria-hidden="true"
    >
        <defs>
            <clipPath id="stripe-clip">
                <rect width={sidebarW} height={stripeH} />
            </clipPath>
        </defs>
        <g clip-path="url(#stripe-clip)">
            <rect width={sidebarW} height={stripeH} fill="var(--color-bg)" />
            {#each stripes as stripe}
                <polygon
                    points={stripe.points}
                    fill={stripe.red
                        ? 'var(--color-accent)'
                        : 'var(--color-accent-2)'}
                />
            {/each}
        </g>
    </svg>
    <div class="header">
        <svg
            width="32"
            height="32"
            viewBox="0 0 18 18"
            fill="none"
            aria-hidden="true"
            style="transform: translateY(-2px)"
        >
            <rect
                x="1"
                y="3"
                width="16"
                height="12"
                rx="2"
                stroke="currentColor"
                stroke-width="1.5"
            />
            <path
                d="M1 6l8 5 8-5"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linejoin="round"
            />
        </svg>
        <span class="logo-text">CourierAI</span>
    </div>

    <div class="actions">
        <div class="search-box">
            <svg
                class="search-icon"
                width="13"
                height="13"
                viewBox="0 0 13 13"
                fill="none"
                aria-hidden="true"
            >
                <circle
                    cx="5.5"
                    cy="5.5"
                    r="4"
                    stroke="currentColor"
                    stroke-width="1.5"
                />
                <path
                    d="M8.5 8.5l3 3"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                />
            </svg>
            <input
                class="search-input"
                type="search"
                placeholder="Search"
                bind:value={searchValue}
                onkeydown={(e) => {
                    if (e.key === 'Enter' && searchValue.trim())
                        onsearch(searchValue.trim());
                    if (e.key === 'Escape') {
                        searchValue = '';
                        onclearsearch();
                    }
                }}
                oninput={() => {
                    if (!searchValue) onclearsearch();
                }}
            />
            {#if searchValue}
                <button
                    type="button"
                    class="search-clear-btn"
                    onclick={() => {
                        searchValue = '';
                        onclearsearch();
                    }}
                    aria-label="Clear search"
                >
                    <svg
                        width="10"
                        height="10"
                        viewBox="0 0 10 10"
                        fill="none"
                        aria-hidden="true"
                    >
                        <path
                            d="M2 2l6 6M8 2l-6 6"
                            stroke="currentColor"
                            stroke-width="1.5"
                            stroke-linecap="round"
                        />
                    </svg>
                </button>
            {/if}
        </div>
        <button type="button" class="new-chat-btn" onclick={onnewchat}>
            <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
                aria-hidden="true"
            >
                <path
                    d="M7 1v12M1 7h12"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                />
            </svg>
            New Chat
        </button>
    </div>

    <nav
        class="history"
        class:hovered={historyHovered}
        aria-label="Chat history"
        onmouseenter={() => (historyHovered = true)}
        onmouseleave={() => (historyHovered = false)}
    >
        {#if searchResults !== null}
            <p class="section-label">
                {searchResults.length} result{searchResults.length === 1
                    ? ''
                    : 's'}
            </p>
            {#if searchResults.length === 0}
                <p class="empty">No matches found</p>
            {:else}
                {#each searchResults as result (result.id)}
                    <div
                        class="chat-row"
                        class:active={result.id === activeChatId}
                    >
                        <button
                            type="button"
                            class="chat-item"
                            onclick={() =>
                                onselectchat(result.id, result.matchIndex)}
                            title={result.title}
                        >
                            <span class="chat-title"
                                >{@html highlightSnippet(
                                    result.title,
                                    searchQuery,
                                )}</span
                            >
                            {#if result.snippet}
                                <span class="search-snippet"
                                    >{@html highlightSnippet(
                                        result.snippet,
                                        searchQuery,
                                    )}</span
                                >
                            {/if}
                        </button>
                    </div>
                {/each}
            {/if}
        {:else}
            <p class="section-label">Recent Chats</p>
            {#if chats.length === 0}
                <p class="empty">No conversations yet</p>
            {:else}
                {#each chats as chat (chat.id)}
                    <div
                        class="chat-row"
                        class:active={chat.id === activeChatId}
                    >
                        {#if renamingChatId === chat.id}
                            <input
                                class="chat-rename-input"
                                use:focusAndSelect
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
                                class="chat-item"
                                onclick={() => onselectchat(chat.id)}
                                title={chat.title}
                            >
                                <span class="chat-title">{chat.title}</span>
                            </button>
                        {/if}
                        {#if streamingChatIds.includes(chat.id) && chat.id !== activeChatId}
                            <span class="chat-status" aria-label="Streaming">
                                <svg
                                    class="spinner"
                                    width="12"
                                    height="12"
                                    viewBox="0 0 12 12"
                                    fill="none"
                                    aria-hidden="true"
                                >
                                    <circle
                                        cx="6"
                                        cy="6"
                                        r="4.5"
                                        stroke="currentColor"
                                        stroke-width="1.5"
                                        stroke-dasharray="18 8"
                                        stroke-linecap="round"
                                    />
                                </svg>
                            </span>
                        {:else if chatErrors[chat.id]}
                            <span
                                class="chat-status chat-status--error"
                                aria-label="Error">!</span
                            >
                        {/if}
                        <button
                            type="button"
                            class="menu-btn"
                            class:active={openMenuChat?.id === chat.id}
                            aria-label="Chat options"
                            onclick={(e) => openMenu(e, chat)}
                        >
                            <svg
                                width="13"
                                height="13"
                                viewBox="0 0 24 24"
                                fill="none"
                                aria-hidden="true"
                            >
                                <circle
                                    cx="12"
                                    cy="12"
                                    r="3"
                                    stroke="currentColor"
                                    stroke-width="1.75"
                                    stroke-linecap="round"
                                    stroke-linejoin="round"
                                />
                                <path
                                    d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"
                                    stroke="currentColor"
                                    stroke-width="1.75"
                                    stroke-linecap="round"
                                    stroke-linejoin="round"
                                />
                            </svg>
                        </button>
                    </div>
                {/each}
                {#if hasMoreChats}
                    <button
                        type="button"
                        class="load-more-btn"
                        onclick={onloadmore}
                        disabled={isLoadingMore}
                    >
                        {isLoadingMore ? 'Loading…' : 'Load More'}
                    </button>
                {/if}
            {/if}
        {/if}
    </nav>

    <div class="footer">
        <button
            type="button"
            class="settings-btn"
            class:active={showSettings}
            onclick={() => {
                if (demoMode) {
                    onextensionneeded();
                    return;
                }
                showSettings = !showSettings;
            }}
        >
            <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
            >
                <circle
                    cx="12"
                    cy="12"
                    r="3"
                    stroke="currentColor"
                    stroke-width="1.75"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                />
                <path
                    d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"
                    stroke="currentColor"
                    stroke-width="1.75"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                />
            </svg>
            Settings
        </button>
    </div>
</aside>

{#if openMenuChat}
    <div
        class="chat-menu"
        style="top: {menuPos.top}px; left: {menuPos.left}px;"
    >
        <button
            type="button"
            class="chat-menu-item"
            onclick={(e) => {
                e.stopPropagation();
                startRename(openMenuChat!.id, openMenuChat!.title);
            }}
        >
            <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                aria-hidden="true"
            >
                <path
                    d="M8.5 1.5l2 2L3 11H1V9L8.5 1.5Z"
                    stroke="currentColor"
                    stroke-width="1.25"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                />
            </svg>
            Rename
        </button>
        <button
            type="button"
            class="chat-menu-item"
            onclick={(e) => {
                e.stopPropagation();
                onexportchat(openMenuChat!.id);
                closeMenu();
            }}
        >
            <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                aria-hidden="true"
            >
                <path
                    d="M6 1v7M3 5.5l3 3 3-3M1 10.5h10"
                    stroke="currentColor"
                    stroke-width="1.25"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                />
            </svg>
            Export
        </button>
        <div class="chat-menu-divider"></div>
        <button
            type="button"
            class="chat-menu-item chat-menu-item--danger"
            onclick={(e) => {
                e.stopPropagation();
                ondeletechat(openMenuChat!.id);
                closeMenu();
            }}
        >
            <svg
                width="12"
                height="12"
                viewBox="0 0 13 13"
                fill="none"
                aria-hidden="true"
            >
                <path
                    d="M2 4h9M5 4V2.5h3V4M3.5 4l.5 7h5l.5-7"
                    stroke="currentColor"
                    stroke-width="1.25"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                />
            </svg>
            Delete
        </button>
    </div>
{/if}

{#if showSettings}
    <SettingsPopover
        bind:theme
        bind:fontSizeIndex
        bind:chatWidth
        bind:smoothTextMode
        bind:submitKeystroke
        bind:modelTier
        onclose={() => (showSettings = false)}
    />
{/if}

<style>
    .sidebar {
        width: 256px;
        flex-shrink: 0;
        display: flex;
        flex-direction: column;
        background-color: var(--color-bg);
        border-right: 1px solid var(--color-border);
        overflow: hidden;
        -webkit-user-select: none;
        user-select: none;
    }

    .sidebar input {
        -webkit-user-select: text;
        user-select: text;
    }

    .airmail-stripe {
        display: block;
        flex-shrink: 0;
    }

    .header {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        padding: 18px 16px;
        color: var(--color-text);
        border-bottom: 1px solid var(--color-border);
        flex-shrink: 0;
    }

    .logo-text {
        font-size: 34px;
        font-weight: 600;
        font-family: Courier, monospace;
        letter-spacing: -0.02em;
    }

    .actions {
        padding: 12px 12px 12px;
        flex-shrink: 0;
        display: flex;
        flex-direction: column;
        gap: 6px;
        border-bottom: 1px solid var(--color-border);
    }

    .search-box {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 7px 10px;
        background-color: var(--color-bg);
        border: 1px solid var(--color-border);
        border-radius: 8px;
        box-sizing: border-box;
        opacity: 0.45;
        transition:
            opacity 0.15s,
            border-color 0.15s;
    }

    .search-box:focus-within {
        opacity: 1;
        border-color: var(--color-text-muted);
    }

    .search-icon {
        flex-shrink: 0;
        color: var(--color-text);
    }

    .search-input {
        flex: 1;
        background: none;
        border: none;
        outline: none;
        font-family: var(--font-sans);
        font-size: 0.8125rem;
        color: var(--color-text);
        min-width: 0;
    }

    .search-input::placeholder {
        color: var(--color-text);
    }

    .search-input::-webkit-search-cancel-button {
        -webkit-appearance: none;
    }

    .search-clear-btn {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        padding: 0;
        background: none;
        border: none;
        border-radius: 3px;
        color: var(--color-text-muted);
        cursor: pointer;
        opacity: 0.6;
        transition: opacity 0.1s;
    }

    .search-clear-btn:hover {
        opacity: 1;
    }

    .new-chat-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        width: 100%;
        padding: 9px 12px;
        background-color: var(--color-accent);
        color: var(--color-bg);
        border: none;
        border-radius: 8px;
        font-size: 0.8125rem;
        font-weight: 500;
        cursor: pointer;
        transition: background-color 0.15s;
    }

    .new-chat-btn:hover {
        background-color: var(--color-accent-hover);
    }

    .history {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 4px 8px;
    }

    .history::-webkit-scrollbar {
        width: 3px;
    }

    .history::-webkit-scrollbar-track {
        background: transparent;
    }

    .history::-webkit-scrollbar-thumb {
        background-color: transparent;
        border-radius: 3px;
    }

    .history.hovered::-webkit-scrollbar-thumb {
        background-color: var(--color-border);
    }

    .section-label {
        padding: 10px 10px 4px;
        font-size: 0.6875rem;
        font-weight: 600;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--color-text-muted);
    }

    .empty {
        padding: 8px 8px 20px;
        font-size: 0.8125rem;
        color: var(--color-text);
        text-align: center;
    }

    .load-more-btn {
        display: block;
        width: 100%;
        padding: 8px 10px;
        margin-top: 2px;
        background: none;
        border: none;
        border-radius: 6px;
        font-size: 0.8125rem;
        color: var(--color-text-muted);
        cursor: pointer;
        text-align: center;
        transition:
            background-color 0.1s,
            color 0.1s;
    }

    .load-more-btn:hover:not(:disabled) {
        background-color: var(--color-surface-raised);
        color: var(--color-text);
    }

    .load-more-btn:disabled {
        cursor: default;
        opacity: 0.5;
    }

    .chat-row {
        display: flex;
        align-items: center;
        border-radius: 6px;
        margin-bottom: 1px;
        transition: background-color 0.1s;
    }

    .chat-row:hover {
        background-color: var(--color-surface-raised);
    }

    .chat-row.active {
        background-color: var(--color-surface-raised);
    }

    .chat-item {
        flex: 1;
        min-width: 0;
        padding: 8px 10px;
        background: none;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        text-align: left;
    }

    .chat-title {
        display: block;
        font-size: 0.8125rem;
        color: var(--color-text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .chat-row.active .chat-title {
        color: var(--color-accent);
    }

    .menu-btn {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        padding: 0;
        margin-right: 6px;
        background: none;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        color: var(--color-text-muted);
        opacity: 0;
        transition:
            opacity 0.1s,
            color 0.1s,
            background-color 0.1s;
    }

    .chat-row:hover .menu-btn,
    .menu-btn.active {
        opacity: 1;
    }

    .menu-btn:hover,
    .menu-btn.active {
        color: var(--color-accent);
        background-color: var(--color-surface-sunken, var(--color-bg));
    }

    .chat-rename-input {
        flex: 1;
        min-width: 0;
        padding: 6px 10px;
        background: var(--color-bg);
        border: 1px solid var(--color-accent);
        border-radius: 6px;
        outline: none;
        font-family: var(--font-sans);
        font-size: 0.8125rem;
        color: var(--color-text);
    }

    .chat-menu {
        position: fixed;
        z-index: 200;
        min-width: 140px;
        background-color: var(--color-surface-raised);
        border: 1px solid var(--color-border);
        border-radius: 8px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
        padding: 4px;
        display: flex;
        flex-direction: column;
        -webkit-user-select: none;
        user-select: none;
    }

    .chat-menu-divider {
        height: 1px;
        background-color: var(--color-border);
        margin: 3px 0;
    }

    .chat-menu-item {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 7px 10px;
        background: none;
        border: none;
        border-radius: 5px;
        font-size: 0.8125rem;
        font-family: var(--font-sans);
        color: var(--color-text);
        cursor: pointer;
        text-align: left;
        transition:
            background-color 0.1s,
            color 0.1s;
    }

    .chat-menu-item:hover {
        background-color: var(--color-bg);
    }

    .chat-menu-item--danger:hover {
        color: var(--color-accent);
    }

    .chat-status {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        margin-right: 2px;
        font-size: 0.75rem;
        font-weight: 700;
        color: var(--color-text-muted);
    }

    .chat-status--error {
        color: var(--color-accent);
    }

    .search-snippet {
        display: block;
        font-size: 0.6875rem;
        color: var(--color-text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        margin-top: 1px;
    }

    :global(.search-mark) {
        background-color: var(--color-accent-2);
        color: var(--color-surface-sunken);
        border-radius: 2px;
        padding: 0 1px;
    }

    @keyframes spin {
        to {
            transform: rotate(360deg);
        }
    }

    .spinner {
        animation: spin 0.8s linear infinite;
        transform-box: fill-box;
        transform-origin: center;
    }

    .footer {
        padding: 13px 12px;
        border-top: 1px solid var(--color-border);
        flex-shrink: 0;
    }

    .settings-btn {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        height: calc(20px + 0.875rem * 1.5);
        padding: 0 10px;
        background: none;
        border: none;
        border-radius: 6px;
        font-size: 0.8125rem;
        color: var(--color-text);
        cursor: pointer;
        transition:
            background-color 0.1s,
            color 0.1s;
    }

    .settings-btn:hover {
        background-color: var(--color-surface-raised);
        color: var(--color-text);
    }

    .settings-btn.active {
        background-color: var(--color-surface-raised);
        color: var(--color-accent);
    }
</style>
