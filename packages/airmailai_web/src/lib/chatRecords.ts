import type {
    AirmailAIMessage,
    ChatMeta,
    DraftAttachment,
    SiteChatMeta,
    StoredMessage,
} from '@airmailai/shared';
import { cleanInline } from './chatTransfer';
import type { Chat, Message } from './types';

const AUTO_TITLE_CHARS = 40;

export function chatTitleFor(
    content: string,
    attachments: DraftAttachment[]
): string {
    return (
        cleanInline(content.replace(/\s+/g, ' '), AUTO_TITLE_CHARS) ||
        cleanInline(attachments[0]?.name, AUTO_TITLE_CHARS) ||
        'Empty chat'
    );
}

export function buildUserMessage(
    id: string,
    createdAt: number,
    content: string,
    attachments?: DraftAttachment[]
): AirmailAIMessage {
    const parts: AirmailAIMessage['parts'] = [];
    if (content) {
        parts.push({ type: 'text', text: content, state: 'done' });
    }
    for (const att of attachments ?? []) {
        parts.push({
            type: 'file',
            filename: att.name,
            mediaType: att.mediaType,
            sizeBytes: att.sizeBytes,
            hash: att.hash,
        });
    }
    return {
        id,
        role: 'user',
        parts,
        metadata: { createdAt },
    };
}

export function buildAssistantPlaceholder(
    id: string,
    createdAt: number
): AirmailAIMessage {
    return {
        id,
        role: 'assistant',
        parts: [],
        metadata: { createdAt },
    };
}

export function toStoredMessage(
    chatId: string,
    msg: AirmailAIMessage
): StoredMessage {
    return { chatId, message: msg };
}

export function storedToMessages(stored: StoredMessage[]): Message[] {
    return stored.map((s) => s.message);
}

export function chatToMeta(chat: Chat): SiteChatMeta {
    return {
        customModel: chat.customModel ? { ...chat.customModel } : null,
        id: chat.id,
        title: chat.title,
        createdAt: chat.createdAt,
        ...(chat.lastMessageAt !== undefined
            ? { lastMessageAt: chat.lastMessageAt }
            : {}),
        providerId: chat.providerId,
        modelId: chat.modelId,
        temperature: chat.temperature,
        maxTokens: chat.maxTokens,
        thinkingLevel: chat.thinkingLevel,
        adaptiveThinking: chat.adaptiveThinking,
        webSearch: chat.webSearch,
        webFetch: chat.webFetch,
        codeExecution: chat.codeExecution,
        systemPrompt: chat.systemPrompt,
    };
}

export function chatFromMeta(meta: ChatMeta): Chat {
    return { ...meta, messages: [], loadState: 'unloaded' };
}

export function snapshotChat(chat: Chat): Chat {
    return {
        ...chat,
        messages: [...chat.messages],
        draftAttachments: [...(chat.draftAttachments ?? [])],
    };
}

export function removeMessageById(chat: Chat, messageId: string): void {
    const index = chat.messages.findIndex((m) => m.id === messageId);
    if (index >= 0) chat.messages.splice(index, 1);
}
