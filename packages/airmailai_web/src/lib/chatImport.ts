import { errorMessage } from '@airmailai/shared';
import type { ImportChatEntry, ProviderId } from '@airmailai/shared';
import { appMode } from './appMode.svelte';
import { chatFromMeta, chatToMeta } from './chatRecords';
import { readChatTransferFile, type ImportedChat } from './chatTransfer';
import { reportAppError } from './errorStore.svelte';
import { IMPORT_BATCH_CHARS, importChats } from './extension';
import { log } from './log';
import { providersStore } from './providersStore.svelte';
import { settingsStore } from './settingsStore.svelte';
import type { Chat, Message } from './types';

function resolveImportedModel(
    model: string | null,
    custom: boolean
): { providerId: ProviderId; modelId: string } | null {
    if (!model) return null;
    const slash = model.indexOf('/');
    if (slash <= 0) return null;
    const providerId = model.slice(0, slash);
    const modelId = model.slice(slash + 1);
    const provider = providersStore.providers.find((p) => p.id === providerId);
    if (!provider) return null;
    if (!custom && !provider.models.some((m) => m.id === modelId)) return null;
    return { providerId: provider.id, modelId };
}

function buildImportedChat(imp: ImportedChat): Chat {
    const createdAt = imp.createdAt || Date.now();
    const resolved = resolveImportedModel(imp.model, !!imp.customModel);
    const messages: Message[] = imp.messages.map((m, i) => ({
        id: crypto.randomUUID(),
        role: m.role,
        parts: [{ type: 'text', text: m.text, state: 'done' }],
        metadata: { createdAt: createdAt + i },
    }));
    return {
        id: crypto.randomUUID(),
        title: imp.title || 'Imported Chat',
        messages,
        loadState: 'loaded',
        createdAt,
        lastMessageAt: messages.length
            ? messages[messages.length - 1].metadata.createdAt
            : createdAt,
        ...settingsStore.snapshotChatConfig(),
        ...(resolved
            ? {
                  ...resolved,
                  customModel: imp.customModel ? { ...imp.customModel } : null,
              }
            : {}),
        systemPrompt: imp.systemPrompt,
    };
}

export async function importChatsFromFile(
    file: File,
    onSaved: (chats: Chat[]) => void
): Promise<void> {
    let batch: ImportChatEntry[] = [];
    let batchChars = 0;
    let saved = 0;
    let skipped = 0;
    const errors: string[] = [];
    const skip = (count: number, message: string) => {
        skipped += count;
        if (errors.length < 3) errors.push(message);
        log.warn('import:', message);
    };
    const flush = async () => {
        if (!batch.length) return;
        try {
            await importChats(batch, batchChars);
        } catch (err) {
            skip(
                batch.length,
                `Couldn't save "${batch[0].meta.title}"${batch.length > 1 ? ' and its batch' : ''}: ${errorMessage(err)}`
            );
            batch = [];
            batchChars = 0;
            return;
        }
        onSaved(batch.map(({ meta }) => chatFromMeta(meta)));
        saved += batch.length;
        batch = [];
        batchChars = 0;
    };
    try {
        for await (const record of readChatTransferFile(file)) {
            if ('error' in record) {
                skip(1, record.error);
                continue;
            }
            const chat = buildImportedChat(record.chat);
            if (appMode.isDemo) {
                onSaved([chat]);
                saved++;
                continue;
            }
            const entry = { meta: chatToMeta(chat), messages: chat.messages };
            const chars = JSON.stringify(entry).length;
            if (batchChars + chars > IMPORT_BATCH_CHARS) await flush();
            batch.push(entry);
            batchChars += chars;
            if (batchChars >= IMPORT_BATCH_CHARS) await flush();
        }
    } catch (err) {
        await flush();
        reportAppError(
            `import: read failed (${file.name})`,
            `Couldn't finish importing ${file.name} (${saved} saved, ${skipped} skipped)`,
            err
        );
        return;
    }
    await flush();
    if (skipped) {
        reportAppError(
            `import: skipped records (${file.name})`,
            `Imported ${saved} chats and skipped ${skipped} in ${file.name}`,
            errors.join('; ')
        );
    }
    log.info('imported chats', `${saved} from ${file.name}`);
}
