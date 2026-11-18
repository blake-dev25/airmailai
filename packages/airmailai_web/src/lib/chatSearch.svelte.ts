import type { StoredChat } from '@airmailai/shared';
import { SvelteMap } from 'svelte/reactivity';
import { storedToMessages } from './chatRecords';
import { reportAppError } from './errorStore.svelte';
import { loadChatsByIds } from './extension';
import { log } from './log';
import {
    messageText,
    type Chat,
    type Message,
    type SearchResult,
} from './types';

type SearchState =
    | { kind: 'inactive' }
    | { kind: 'results'; query: string; results: SearchResult[] }
    | { kind: 'loading-all'; query: string; results: SearchResult[] };

function matchChat(
    id: string,
    title: string,
    messages: Message[],
    q: string
): SearchResult | null {
    for (let i = 0; i < messages.length; i++) {
        const content = messageText(messages[i]);
        const idx = content.toLowerCase().indexOf(q);
        if (idx !== -1) {
            const start = Math.max(0, idx - 40);
            const end = Math.min(content.length, idx + q.length + 60);
            const snippet =
                (start > 0 ? '...' : '') +
                content.slice(start, end) +
                (end < content.length ? '...' : '');
            return { id, title, snippet, matchIndex: i };
        }
    }
    if (title.toLowerCase().includes(q)) {
        const firstMsg = messages.find((m) => messageText(m).length > 0);
        const firstText = firstMsg ? messageText(firstMsg) : '';
        const snippet = firstText
            ? firstText.slice(0, 100) + (firstText.length > 100 ? '...' : '')
            : '';
        return { id, title, snippet, matchIndex: null };
    }
    return null;
}

export class ChatSearch {
    state = $state.raw<SearchState>({ kind: 'inactive' });
    highlightMessageIndex = $state<number | null>(null);
    private unloadedChatMessages = new SvelteMap<string, Message[]>();
    private readonly getChats: () => Chat[];
    unsearchedChatCount = $derived.by(() => this.unsearchedChats().length);

    constructor(getChats: () => Chat[]) {
        this.getChats = getChats;
    }

    private unsearchedChats(): Chat[] {
        return this.getChats().filter(
            (c) =>
                c.loadState !== 'loaded' && !this.unloadedChatMessages.has(c.id)
        );
    }

    private matchAll(query: string): SearchResult[] {
        const q = query.toLowerCase();
        const results: SearchResult[] = [];
        for (const chat of this.getChats()) {
            const messages =
                chat.loadState === 'loaded'
                    ? chat.messages
                    : this.unloadedChatMessages.get(chat.id);
            if (!messages) continue;
            const result = matchChat(chat.id, chat.title, messages, q);
            if (result) results.push(result);
        }
        return results;
    }

    run(query: string): void {
        this.highlightMessageIndex = null;
        this.state = {
            kind: this.state.kind === 'loading-all' ? 'loading-all' : 'results',
            query,
            results: this.matchAll(query),
        };
    }

    refreshResults(): void {
        if (this.state.kind === 'inactive') return;
        this.state = {
            ...this.state,
            results: this.matchAll(this.state.query),
        };
    }

    clear(): void {
        this.state = { kind: 'inactive' };
        this.highlightMessageIndex = null;
        this.unloadedChatMessages.clear();
    }

    forgetChat(chatId: string): void {
        this.unloadedChatMessages.delete(chatId);
    }

    async searchAllChats(): Promise<void> {
        if (this.state.kind !== 'results') return;
        const unsearchedIds = this.unsearchedChats().map((c) => c.id);
        if (unsearchedIds.length === 0) return;
        this.state = { ...this.state, kind: 'loading-all' };
        let fullChats: StoredChat[];
        try {
            fullChats = await loadChatsByIds(unsearchedIds);
        } catch (err) {
            if (this.state.kind === 'loading-all')
                this.state = { ...this.state, kind: 'results' };
            reportAppError(
                'searchAllChats failed',
                "Couldn't load all chats for search",
                err
            );
            return;
        }
        if (this.state.kind !== 'loading-all') return;
        const loaded = new Map(
            fullChats.map((s) => [s.id, storedToMessages(s.messages)])
        );
        for (const id of unsearchedIds) {
            this.unloadedChatMessages.set(id, loaded.get(id) ?? []);
        }
        log.info('search cache built', `${fullChats.length} chats`);
        this.state = {
            kind: 'results',
            query: this.state.query,
            results: this.matchAll(this.state.query),
        };
    }
}
