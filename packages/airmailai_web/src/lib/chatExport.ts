import type { ChatMeta } from '@airmailai/shared';
import { storedToMessages } from './chatRecords';
import {
    backupFilename,
    buildBackupDocument,
    buildAirmailAIJsonExport,
    buildJsonExport,
    buildMarkdownExport,
    buildSillyTavernExport,
    exportFilename,
    sillyTavernFilename,
    type ChatExportFormat,
    type TransferChatInfo,
} from './chatTransfer';
import { reportAppError } from './errorStore.svelte';
import { loadChat, loadChatMetas } from './extension';
import { triggerBlobDownload } from './files';
import { log } from './log';
import type { Chat } from './types';

function transferInfo(meta: TransferChatInfo): TransferChatInfo {
    return {
        customModel: meta.customModel ? { ...meta.customModel } : null,
        title: meta.title,
        createdAt: meta.createdAt,
        systemPrompt: meta.systemPrompt,
        providerId: meta.providerId,
        modelId: meta.modelId,
    };
}

export async function exportChat(
    chat: Chat,
    format: ChatExportFormat
): Promise<void> {
    let messages = chat.messages;
    if (chat.loadState !== 'loaded') {
        try {
            const full = await loadChat(chat.id);
            if (full) messages = storedToMessages(full.messages);
        } catch (err) {
            reportAppError(
                `export: loadChat failed (id=${chat.id})`,
                "Couldn't load chat for export",
                err
            );
            return;
        }
    }

    const info = transferInfo(chat);
    let content: string;
    let filename: string;
    let mimeType: string;
    if (format === 'airmailai') {
        content = buildAirmailAIJsonExport(info, messages);
        filename = exportFilename(chat.title, chat.createdAt, '.json');
        mimeType = 'application/json';
    } else if (format === 'lmstudio') {
        content = buildJsonExport(info, messages);
        filename = `${chat.createdAt}.conversation.json`;
        mimeType = 'application/json';
    } else if (format === 'sillytavern') {
        content = buildSillyTavernExport(info, messages);
        filename = sillyTavernFilename(chat.title, chat.createdAt);
        mimeType = 'text/plain';
    } else {
        content = buildMarkdownExport(info, messages);
        filename = exportFilename(chat.title, chat.createdAt, '.md');
        mimeType = 'text/markdown';
    }
    triggerBlobDownload(filename, new Blob([content], { type: mimeType }));
    log.info('exported chat', chat.id, filename);
}

export async function exportAllChats(): Promise<void> {
    let metas: ChatMeta[];
    try {
        metas = await loadChatMetas();
    } catch (err) {
        reportAppError(
            'exportAllChats: metas failed',
            "Couldn't load chat list for backup",
            err
        );
        return;
    }
    if (metas.length === 0) {
        reportAppError(
            'exportAllChats: nothing to export',
            'There are no chats to back up'
        );
        return;
    }
    const sorted = metas.slice().sort((a, b) => a.createdAt - b.createdAt);
    const parts: Blob[] = [];
    let exported = 0;
    try {
        for (const meta of sorted) {
            const stored = await loadChat(meta.id);
            if (!stored) {
                throw new Error(
                    `Conversation "${meta.title}" was deleted during backup. Please try again.`
                );
            }
            const document = buildBackupDocument(
                transferInfo(meta),
                storedToMessages(stored.messages)
            );
            parts.push(new Blob([exported ? '---\n' : '', document]));
            exported++;
        }
    } catch (err) {
        reportAppError(
            'exportAllChats: chats failed',
            "Couldn't load chats for backup",
            err
        );
        return;
    }
    triggerBlobDownload(
        backupFilename(new Date()),
        new Blob(parts, {
            type: 'application/yaml',
        })
    );
    log.info('exported backup', `${exported} chats`);
}
