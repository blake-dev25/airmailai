import type {
    ChatMeta,
    ChatPage,
    ChatPageCursor,
    AirmailAIMessage,
    DraftAttachment,
    ImportChatEntry,
    LocalFileInfo,
    ProviderFileEntry,
    ProviderFileRef,
    ProviderId,
    SiteChatMeta,
    StoredChat,
    StoredMessage,
} from '@airmailai/shared';
import { HISTORY_PAGE_CHARS, PROVIDER_IDS } from '@airmailai/shared';
import { log } from '../debug';

interface IdbUsage {
    chatHistoryBytes: number;
    filesBytes: number;
}

const DB_NAME = 'airmailai';
const DB_VERSION = 16;
const SCHEMA_BASELINE_VERSION = 16;

const STORE_MESSAGES = 'chat_messages';
const STORE_META = 'chat_meta';
const STORE_FILES = 'files';
const STORE_FILE_META = 'file_meta';
const INDEX_CHAT_ORDER = 'chat_order';

const FILE_STORE_NAMES = [
    STORE_MESSAGES,
    STORE_META,
    STORE_FILES,
    STORE_FILE_META,
];

const KEY_MAX = String.fromCharCode(0xffff);

interface FileRecord {
    hash: string;
    blob: Blob;
    createdAt: number;
}

interface FileMetaRecord {
    hash: string;
    filename: string;
    mediaType: string;
    chats: string[];
    providers: Partial<Record<ProviderId, ProviderFileEntry>>;
}

interface FileStores {
    messagesStore: IDBObjectStore;
    chatMetaStore: IDBObjectStore;
    filesStore: IDBObjectStore;
    fileMetaStore: IDBObjectStore;
}

let dbOpening: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (event) => {
            if (event.oldVersion >= SCHEMA_BASELINE_VERSION) return;
            const db = req.result;
            for (const name of Array.from(db.objectStoreNames)) {
                db.deleteObjectStore(name);
            }
            const messages = db.createObjectStore(STORE_MESSAGES, {
                keyPath: ['chatId', 'message.id'],
            });
            messages.createIndex(
                INDEX_CHAT_ORDER,
                ['chatId', 'message.metadata.createdAt', 'message.id'],
                { unique: false }
            );
            db.createObjectStore(STORE_META, { keyPath: 'id' });
            db.createObjectStore(STORE_FILES, { keyPath: 'hash' });
            db.createObjectStore(STORE_FILE_META, { keyPath: 'hash' });
        };
        req.onsuccess = () => {
            log.info('IndexedDB opened');
            resolve(req.result);
        };
        req.onerror = () => reject(req.error);
    });
}

function getDb(): Promise<IDBDatabase> {
    dbOpening ??= openDb().catch((error: unknown) => {
        dbOpening = null;
        throw error;
    });
    return dbOpening;
}

function reqAsPromise<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function txDone(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

function abortActiveTransaction(tx: IDBTransaction): void {
    try {
        tx.abort();
    } catch (err) {
        if (!(
            err instanceof DOMException && err.name === 'InvalidStateError'
        )) {
            log.warn('db: transaction abort failed', err);
        }
    }
}

async function withTransaction<T>(
    storeNames: string | string[],
    mode: IDBTransactionMode,
    work: (tx: IDBTransaction) => Promise<T>
): Promise<T> {
    const db = await getDb();
    const tx = db.transaction(storeNames, mode);
    try {
        const result = await work(tx);
        await txDone(tx);
        return result;
    } catch (err) {
        abortActiveTransaction(tx);
        throw err;
    }
}

function withFileStores<T>(
    work: (stores: FileStores) => Promise<T>
): Promise<T> {
    return withTransaction(FILE_STORE_NAMES, 'readwrite', (tx) =>
        work({
            messagesStore: tx.objectStore(STORE_MESSAGES),
            chatMetaStore: tx.objectStore(STORE_META),
            filesStore: tx.objectStore(STORE_FILES),
            fileMetaStore: tx.objectStore(STORE_FILE_META),
        })
    );
}

function getRecord<T>(
    store: IDBObjectStore,
    key: IDBValidKey
): Promise<T | undefined> {
    return reqAsPromise<T | undefined>(store.get(key));
}

function getAllRecords<T>(
    source: IDBObjectStore | IDBIndex,
    range?: IDBKeyRange
): Promise<T[]> {
    return reqAsPromise<T[]>(source.getAll(range));
}

function forEachCursor<T>(
    request: IDBRequest<IDBCursorWithValue | null>,
    visit: (value: T, cursor: IDBCursorWithValue) => void
): Promise<void> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => {
            try {
                const cursor = request.result;
                if (!cursor) {
                    resolve();
                    return;
                }
                visit(cursor.value as T, cursor);
                cursor.continue();
            } catch (err) {
                reject(err);
            }
        };
        request.onerror = () => reject(request.error);
    });
}

function chatMessagesRange(chatId: string): IDBKeyRange {
    return IDBKeyRange.bound([chatId, ''], [chatId, KEY_MAX]);
}

function messageAttachmentHashes(msg: AirmailAIMessage | null): string[] {
    if (!msg) return [];
    const hashes: string[] = [];
    for (const part of msg.parts) {
        if (part.type === 'file') hashes.push(part.hash);
    }
    return hashes;
}

function messageFileInfos(
    msg: AirmailAIMessage
): Map<string, { filename: string; mediaType: string }> {
    const infos = new Map<string, { filename: string; mediaType: string }>();
    for (const part of msg.parts) {
        if (part.type === 'file') {
            infos.set(part.hash, {
                filename: part.filename,
                mediaType: part.mediaType,
            });
        }
    }
    return infos;
}

function metaProviderRefs(rec: FileMetaRecord): ProviderFileRef[] {
    return PROVIDER_IDS.flatMap((providerId) => {
        const entry = rec.providers[providerId];
        return entry ? [{ providerId, fileId: entry.fileId }] : [];
    });
}

async function ensureFileRef(
    stores: FileStores,
    chatId: string,
    hash: string,
    filename: string,
    mediaType: string,
    freshBlob?: Blob
): Promise<void> {
    const existing = await getRecord<FileMetaRecord>(
        stores.fileMetaStore,
        hash
    );
    const blobKey = await reqAsPromise(stores.filesStore.getKey(hash));
    if (blobKey === undefined) {
        if (freshBlob) {
            const rec: FileRecord = {
                hash,
                blob: freshBlob,
                createdAt: Date.now(),
            };
            stores.filesStore.put(rec);
        } else if (!existing) {
            throw new Error(
                `Missing blob for attachment hash ${hash} - refusing to persist`
            );
        }
    }
    const rec: FileMetaRecord = existing ?? {
        hash,
        filename,
        mediaType,
        chats: [],
        providers: {},
    };
    if (!rec.filename) rec.filename = filename;
    if (!rec.mediaType) rec.mediaType = mediaType;
    if (!rec.chats.includes(chatId)) rec.chats = [...rec.chats, chatId];
    stores.fileMetaStore.put(rec);
}

async function unlistChatFromHashes(
    stores: FileStores,
    chatId: string,
    hashes: Iterable<string>
): Promise<ProviderFileRef[]> {
    const refs: ProviderFileRef[] = [];
    for (const hash of hashes) {
        const rec = await getRecord<FileMetaRecord>(stores.fileMetaStore, hash);
        if (!rec) continue;
        const chats = rec.chats.filter((c) => c !== chatId);
        if (chats.length === rec.chats.length) continue;
        if (chats.length) {
            stores.fileMetaStore.put({ ...rec, chats });
        } else {
            stores.fileMetaStore.delete(hash);
            stores.filesStore.delete(hash);
            refs.push(...metaProviderRefs(rec));
        }
    }
    return refs;
}

async function reconcileChatFileRefs(
    stores: FileStores,
    chatId: string,
    hashes: Set<string>
): Promise<ProviderFileRef[]> {
    if (!hashes.size) return [];
    const remaining = new Set<string>();
    await forEachCursor<StoredMessage>(
        stores.messagesStore.openCursor(chatMessagesRange(chatId)),
        (row) => {
            for (const hash of messageAttachmentHashes(row.message)) {
                if (hashes.has(hash)) remaining.add(hash);
            }
        }
    );
    const meta = await getRecord<ChatMeta>(stores.chatMetaStore, chatId);
    for (const d of meta?.draftAttachments ?? []) {
        if (hashes.has(d.hash)) remaining.add(d.hash);
    }
    const gone = [...hashes].filter((h) => !remaining.has(h));
    return unlistChatFromHashes(stores, chatId, gone);
}

function messageCreatedAt(msg: StoredMessage): number {
    const createdAt = msg.message.metadata?.createdAt;
    if (!Number.isFinite(createdAt)) {
        throw new Error(
            `Message ${msg.message.id} has no valid createdAt - refusing to persist`
        );
    }
    return createdAt;
}

function mergeChatMeta(
    existing: ChatMeta | undefined,
    meta: SiteChatMeta,
    draftAttachments = existing?.draftAttachments,
    messagesChanged = false
): ChatMeta & { revision: number } {
    const lastMessageAt = Math.max(
        existing?.lastMessageAt ?? 0,
        meta.lastMessageAt ?? 0
    );
    return {
        ...meta,
        revision: (existing?.revision ?? 0) + Number(messagesChanged),
        ...(lastMessageAt ? { lastMessageAt } : {}),
        draftAttachments,
        containerId: existing?.containerId,
        containerProvider: existing?.containerProvider,
        containerExpiresAt: existing?.containerExpiresAt,
        containerFileIds: existing?.containerFileIds,
    };
}

async function putMessageInStores(
    stores: FileStores,
    msg: StoredMessage,
    freshBlobs?: Map<string, Blob>
): Promise<Set<string>> {
    const prior = await getRecord<StoredMessage>(stores.messagesStore, [
        msg.chatId,
        msg.message.id,
    ]);
    stores.messagesStore.put({ chatId: msg.chatId, message: msg.message });

    for (const [hash, info] of messageFileInfos(msg.message)) {
        await ensureFileRef(
            stores,
            msg.chatId,
            hash,
            info.filename,
            info.mediaType,
            freshBlobs?.get(hash)
        );
    }

    const nextHashes = new Set(messageAttachmentHashes(msg.message));
    return new Set(
        messageAttachmentHashes(prior?.message ?? null).filter(
            (hash) => !nextHashes.has(hash)
        )
    );
}

async function deleteMessagesAfterInStores(
    stores: FileStores,
    chatId: string,
    lastKeptId: string
): Promise<Set<string>> {
    const boundary = await getRecord<StoredMessage>(stores.messagesStore, [
        chatId,
        lastKeptId,
    ]);
    if (!boundary) {
        throw new Error(
            `Message ${lastKeptId} not found in chat ${chatId} - refusing to truncate`
        );
    }
    const boundaryCreatedAt = boundary.message.metadata?.createdAt ?? 0;
    const range = IDBKeyRange.bound(
        [chatId, boundaryCreatedAt, boundary.message.id],
        [chatId, Number.POSITIVE_INFINITY, KEY_MAX],
        true,
        false
    );
    const removedHashes = new Set<string>();
    await forEachCursor<StoredMessage>(
        stores.messagesStore.index(INDEX_CHAT_ORDER).openCursor(range),
        (row, cursor) => {
            for (const hash of messageAttachmentHashes(row.message)) {
                removedHashes.add(hash);
            }
            cursor.delete();
        }
    );
    return removedHashes;
}

export interface PreparedTurn {
    refs: ProviderFileRef[];
    revision: number;
    meta: ChatMeta;
}

export async function dbPrepareTurn(
    meta: SiteChatMeta,
    msg: StoredMessage
): Promise<PreparedTurn> {
    log.info('db: prepare turn', meta.id, msg.message.id);
    if (msg.chatId !== meta.id) {
        throw new Error(`Message chat ${msg.chatId} does not match ${meta.id}`);
    }
    if (msg.message.role !== 'user') {
        throw new Error(`Message ${msg.message.id} is not a user message`);
    }
    const createdAt = messageCreatedAt(msg);
    return withFileStores(async (stores) => {
        const existing = await getRecord<ChatMeta>(
            stores.chatMetaStore,
            meta.id
        );
        const removed = await putMessageInStores(stores, msg);
        for (const draft of existing?.draftAttachments ?? []) {
            removed.add(draft.hash);
        }
        const merged = mergeChatMeta(
            existing,
            {
                ...meta,
                lastMessageAt: Math.max(meta.lastMessageAt ?? 0, createdAt),
            },
            [],
            true
        );
        stores.chatMetaStore.put(merged);
        const refs = await reconcileChatFileRefs(stores, meta.id, removed);
        return { refs, revision: merged.revision, meta: merged };
    });
}

export async function dbPrepareRetry(
    meta: SiteChatMeta,
    lastKeptId: string
): Promise<PreparedTurn> {
    log.info('db: prepare retry', meta.id, lastKeptId);
    return withFileStores(async (stores) => {
        const existing = await getRecord<ChatMeta>(
            stores.chatMetaStore,
            meta.id
        );
        if (!existing) {
            throw new Error(`Chat ${meta.id} not found for retry`);
        }
        const merged = mergeChatMeta(existing, meta, undefined, true);
        stores.chatMetaStore.put(merged);
        const removed = await deleteMessagesAfterInStores(
            stores,
            meta.id,
            lastKeptId
        );
        const refs = await reconcileChatFileRefs(stores, meta.id, removed);
        return { refs, revision: merged.revision, meta: merged };
    });
}

export async function dbPutMessage(
    msg: StoredMessage,
    freshBlobs?: Map<string, Blob>
): Promise<{ refs: ProviderFileRef[]; revision: number }> {
    log.info('db: put message', msg.chatId, msg.message.id);
    const createdAt = messageCreatedAt(msg);
    return withFileStores(async (stores) => {
        const meta = await getRecord<ChatMeta>(
            stores.chatMetaStore,
            msg.chatId
        );
        if (!meta) {
            throw new Error(`Chat ${msg.chatId} not found for message`);
        }
        const revision = (meta.revision ?? 0) + 1;
        stores.chatMetaStore.put({
            ...meta,
            revision,
            lastMessageAt: Math.max(createdAt, meta.lastMessageAt ?? 0),
        });
        const removed = await putMessageInStores(stores, msg, freshBlobs);
        const refs = await reconcileChatFileRefs(stores, msg.chatId, removed);
        return { refs, revision };
    });
}

export async function dbImportChats(
    entries: ImportChatEntry[]
): Promise<ChatMeta[]> {
    log.info('db: import chats', `${entries.length} chats`);
    if (entries.length === 0) return [];
    return withTransaction(
        [STORE_MESSAGES, STORE_META],
        'readwrite',
        async (tx) => {
            const messagesStore = tx.objectStore(STORE_MESSAGES);
            const chatMetaStore = tx.objectStore(STORE_META);
            const imported: ChatMeta[] = [];
            for (const entry of entries) {
                const chatId = entry.meta.id;
                const existing = await getRecord<ChatMeta>(
                    chatMetaStore,
                    chatId
                );
                let lastMessageAt = entry.meta.lastMessageAt ?? 0;
                for (const message of entry.messages) {
                    const stored: StoredMessage = { chatId, message };
                    lastMessageAt = Math.max(
                        lastMessageAt,
                        messageCreatedAt(stored)
                    );
                    messagesStore.put(stored);
                }
                const merged = mergeChatMeta(
                    existing,
                    {
                        ...entry.meta,
                        ...(lastMessageAt ? { lastMessageAt } : {}),
                    },
                    undefined,
                    true
                );
                chatMetaStore.put(merged);
                imported.push(merged);
            }
            return imported;
        }
    );
}

export async function dbDeleteMessage(
    chatId: string,
    messageId: string
): Promise<{ refs: ProviderFileRef[]; revision: number | null }> {
    log.info('db: delete message', chatId, messageId);
    return withFileStores(async (stores) => {
        const prior = await getRecord<StoredMessage>(stores.messagesStore, [
            chatId,
            messageId,
        ]);
        if (!prior) return { refs: [], revision: null };
        stores.messagesStore.delete([chatId, messageId]);
        const meta = await getRecord<ChatMeta>(stores.chatMetaStore, chatId);
        const revision = meta ? (meta.revision ?? 0) + 1 : null;
        if (meta && revision !== null) {
            stores.chatMetaStore.put({ ...meta, revision });
        }
        const refs = await reconcileChatFileRefs(
            stores,
            chatId,
            new Set(messageAttachmentHashes(prior.message))
        );
        return { refs, revision };
    });
}

export async function dbSaveMeta(meta: SiteChatMeta): Promise<void> {
    log.info('db: save meta', meta.id);
    await withTransaction(STORE_META, 'readwrite', async (tx) => {
        const store = tx.objectStore(STORE_META);
        const existing = await getRecord<ChatMeta>(store, meta.id);
        store.put(mergeChatMeta(existing, meta));
    });
}

export function dbGetMeta(chatId: string): Promise<ChatMeta | undefined> {
    return withTransaction(STORE_META, 'readonly', (tx) =>
        getRecord<ChatMeta>(tx.objectStore(STORE_META), chatId)
    );
}

export async function dbSetContainer(
    chatId: string,
    containerProvider: string,
    containerId: string,
    containerExpiresAt: string | undefined,
    containerFileIds: string[] | undefined
): Promise<void> {
    log.info('db: set container', chatId, containerId);
    await withTransaction(STORE_META, 'readwrite', async (tx) => {
        const store = tx.objectStore(STORE_META);
        const meta = await getRecord<ChatMeta>(store, chatId);
        if (!meta) return;
        store.put({
            ...meta,
            containerProvider,
            containerId,
            containerExpiresAt,
            containerFileIds:
                containerFileIds ??
                (meta.containerId === containerId
                    ? meta.containerFileIds
                    : undefined),
        });
    });
}

async function stageDraftAttachmentInStores(
    stores: FileStores,
    chatId: string,
    attachment: DraftAttachment,
    blob: Blob
): Promise<ChatMeta | null> {
    const hash = attachment.hash;
    const meta = await getRecord<ChatMeta>(stores.chatMetaStore, chatId);
    if (!meta) {
        throw new Error(`Chat ${chatId} not found for draft attachment`);
    }
    const drafts = meta.draftAttachments ?? [];
    if (drafts.some((d) => d.hash === hash)) return null;
    await ensureFileRef(
        stores,
        chatId,
        hash,
        attachment.name,
        attachment.mediaType,
        blob
    );
    const updated: ChatMeta = {
        ...meta,
        draftAttachments: [...drafts, attachment],
    };
    stores.chatMetaStore.put(updated);
    return updated;
}

export async function dbStageDraftAttachment(
    chatId: string,
    attachment: DraftAttachment,
    blob: Blob
): Promise<ChatMeta | null> {
    log.info('db: stage draft attachment', chatId, attachment.hash);
    return withFileStores((stores) =>
        stageDraftAttachmentInStores(stores, chatId, attachment, blob)
    );
}

export interface DraftAttachmentChange {
    refs: ProviderFileRef[];
    meta: ChatMeta | null;
}

export async function dbRemoveDraftAttachment(
    chatId: string,
    key: string
): Promise<DraftAttachmentChange> {
    log.info('db: remove draft attachment', chatId, key);
    return withFileStores(async (stores) => {
        const meta = await getRecord<ChatMeta>(stores.chatMetaStore, chatId);
        const drafts = meta?.draftAttachments ?? [];
        const target = drafts.find((d) => d.hash === key);
        if (!meta || !target) return { refs: [], meta: null };
        const updated: ChatMeta = {
            ...meta,
            draftAttachments: drafts.filter((d) => d.hash !== key),
        };
        stores.chatMetaStore.put(updated);
        const refs = await reconcileChatFileRefs(
            stores,
            chatId,
            new Set([target.hash])
        );
        return { refs, meta: updated };
    });
}

export async function dbClearDraftAttachments(
    chatId: string
): Promise<DraftAttachmentChange> {
    log.info('db: clear draft attachments', chatId);
    return withFileStores(async (stores) => {
        const meta = await getRecord<ChatMeta>(stores.chatMetaStore, chatId);
        if (!meta || !meta.draftAttachments?.length)
            return { refs: [], meta: null };
        const hashes = new Set<string>();
        for (const d of meta.draftAttachments) {
            hashes.add(d.hash);
        }
        const updated: ChatMeta = { ...meta, draftAttachments: [] };
        stores.chatMetaStore.put(updated);
        const refs = await reconcileChatFileRefs(stores, chatId, hashes);
        return { refs, meta: updated };
    });
}

export async function dbDeleteChat(chatId: string): Promise<ProviderFileRef[]> {
    log.info('db: delete chat', chatId);
    return withFileStores(async (stores) => {
        const hashes = new Set<string>();
        const meta = await getRecord<ChatMeta>(stores.chatMetaStore, chatId);
        for (const d of meta?.draftAttachments ?? []) {
            hashes.add(d.hash);
        }
        await forEachCursor<StoredMessage>(
            stores.messagesStore.openCursor(chatMessagesRange(chatId)),
            (row, cursor) => {
                for (const hash of messageAttachmentHashes(row.message)) {
                    hashes.add(hash);
                }
                cursor.delete();
            }
        );
        stores.chatMetaStore.delete(chatId);
        return unlistChatFromHashes(stores, chatId, hashes);
    });
}

export async function dbClearChats(): Promise<void> {
    log.info('db: clear chats');
    await withFileStores(async (stores) => {
        stores.messagesStore.clear();
        stores.chatMetaStore.clear();
        stores.filesStore.clear();
        await forEachCursor<FileMetaRecord>(
            stores.fileMetaStore.openCursor(),
            (rec, cursor) => {
                if (Object.keys(rec.providers).length > 0) {
                    cursor.update({ ...rec, chats: [] });
                } else {
                    cursor.delete();
                }
            }
        );
    });
}

export async function dbWipeAll(): Promise<void> {
    log.info('db: wipe all');
    await withFileStores((stores) => {
        stores.messagesStore.clear();
        stores.chatMetaStore.clear();
        stores.filesStore.clear();
        stores.fileMetaStore.clear();
        return Promise.resolve();
    });
}

export async function dbLoadChatMetas(): Promise<ChatMeta[]> {
    const metas = await withTransaction(STORE_META, 'readonly', (tx) =>
        getAllRecords<ChatMeta>(tx.objectStore(STORE_META))
    );
    log.info('db: load chat metas', `${metas.length} chats`);
    return metas;
}

function requestMessagesForChat(
    messagesStore: IDBObjectStore,
    chatId: string
): Promise<StoredMessage[]> {
    const range = IDBKeyRange.bound(
        [chatId, Number.NEGATIVE_INFINITY, ''],
        [chatId, Number.POSITIVE_INFINITY, KEY_MAX]
    );
    return getAllRecords<StoredMessage>(
        messagesStore.index(INDEX_CHAT_ORDER),
        range
    );
}

export function dbLoadChatPage(
    chatId: string,
    after?: ChatPageCursor,
    messageId?: string
): Promise<ChatPage> {
    return withTransaction(
        [STORE_META, STORE_MESSAGES],
        'readonly',
        async (tx) => {
            const meta = await getRecord<ChatMeta>(
                tx.objectStore(STORE_META),
                chatId
            );
            const page: ChatPage = {
                data: '',
                cursor: null,
                revision: meta?.revision ?? 0,
                exists: !!meta,
            };
            if (!meta) return page;
            const store = tx.objectStore(STORE_MESSAGES);
            const append = (row: StoredMessage): boolean => {
                const json = JSON.stringify(row) + '\n';
                const offset =
                    after?.messageId === row.message.id ? after.offset : 0;
                const remaining = HISTORY_PAGE_CHARS - page.data.length;
                page.data += json.slice(offset, offset + remaining);
                const nextOffset =
                    offset + Math.min(remaining, json.length - offset);
                page.cursor = {
                    createdAt: row.message.metadata.createdAt,
                    messageId: row.message.id,
                    offset: nextOffset < json.length ? nextOffset : 0,
                };
                return page.data.length < HISTORY_PAGE_CHARS;
            };
            if (messageId) {
                const row = await getRecord<StoredMessage>(store, [
                    chatId,
                    messageId,
                ]);
                if (row) {
                    append(row);
                    if (page.cursor?.offset === 0) page.cursor = null;
                }
                return page;
            }
            const range = IDBKeyRange.bound(
                after
                    ? [chatId, after.createdAt, after.messageId]
                    : [chatId, Number.NEGATIVE_INFINITY, ''],
                [chatId, Number.POSITIVE_INFINITY, KEY_MAX],
                after !== undefined && after.offset === 0
            );
            await new Promise<void>((resolve, reject) => {
                const req = store.index(INDEX_CHAT_ORDER).openCursor(range);
                req.onerror = () => reject(req.error);
                req.onsuccess = () => {
                    try {
                        const cursor = req.result;
                        if (!cursor) {
                            page.cursor = null;
                            resolve();
                        } else if (append(cursor.value as StoredMessage)) {
                            cursor.continue();
                        } else resolve();
                    } catch (error) {
                        reject(error);
                    }
                };
            });
            return page;
        }
    );
}

export async function dbLoadChat(chatId: string): Promise<StoredChat | null> {
    const { meta, messages } = await withTransaction(
        [STORE_META, STORE_MESSAGES],
        'readonly',
        async (tx) => {
            const metaReq = getRecord<ChatMeta>(
                tx.objectStore(STORE_META),
                chatId
            );
            const messagesReq = requestMessagesForChat(
                tx.objectStore(STORE_MESSAGES),
                chatId
            );
            return { meta: await metaReq, messages: await messagesReq };
        }
    );
    if (!meta) {
        log.info('db: load chat', chatId, 'not found');
        return null;
    }
    log.info('db: load chat', chatId, `(${messages.length} messages)`);
    return { id: chatId, messages, revision: meta.revision ?? 0 };
}

export async function dbGetStorageUsage(): Promise<IdbUsage> {
    let filesBytes = 0;
    await withTransaction(STORE_FILES, 'readonly', (tx) =>
        forEachCursor<FileRecord>(
            tx.objectStore(STORE_FILES).openCursor(),
            (rec) => {
                filesBytes += rec.blob.size;
            }
        )
    );

    const estimate = await navigator.storage.estimate();
    const total = estimate.usage ?? 0;
    const chatHistoryBytes = Math.max(0, total - filesBytes);
    log.info('db: storage usage', {
        chatHistoryBytes,
        filesBytes,
        total,
    });
    return { chatHistoryBytes, filesBytes };
}

export async function dbGetFileBlob(hash: string): Promise<Blob | null> {
    const rec = await withTransaction(STORE_FILES, 'readonly', (tx) =>
        getRecord<FileRecord>(tx.objectStore(STORE_FILES), hash)
    );
    return rec?.blob ?? null;
}

export async function dbListLocalFiles(): Promise<LocalFileInfo[]> {
    const { records, metas } = await withTransaction(
        [STORE_FILES, STORE_FILE_META],
        'readonly',
        async (tx) => {
            const records = await getAllRecords<FileRecord>(
                tx.objectStore(STORE_FILES)
            );
            const metas = await getAllRecords<FileMetaRecord>(
                tx.objectStore(STORE_FILE_META)
            );
            return { records, metas };
        }
    );
    const metaByHash = new Map(metas.map((m) => [m.hash, m]));
    return records.map((rec) => {
        const meta = metaByHash.get(rec.hash);
        return {
            hash: rec.hash,
            filename: meta?.filename || rec.hash,
            mediaType: meta?.mediaType || rec.blob.type,
            sizeBytes: rec.blob.size,
            createdAt: rec.createdAt,
        };
    });
}

export interface StoredFileDeletion {
    chatIds: string[];
    draftMetas: ChatMeta[];
    refs: ProviderFileRef[];
}

export async function dbDeleteStoredFile(
    hash: string
): Promise<StoredFileDeletion> {
    log.info('db: delete stored file', hash);
    return withFileStores(async (stores) => {
        const affected = new Set<string>();
        const draftMetas: ChatMeta[] = [];
        const refs: ProviderFileRef[] = [];

        const metas = await getAllRecords<ChatMeta>(stores.chatMetaStore);
        for (const m of metas) {
            const drafts = m.draftAttachments;
            if (!drafts?.length) continue;
            const keptDrafts = drafts.filter((d) => d.hash !== hash);
            if (keptDrafts.length === drafts.length) continue;
            const updated = { ...m, draftAttachments: keptDrafts };
            stores.chatMetaStore.put(updated);
            draftMetas.push(updated);
            affected.add(m.id);
        }

        const rec = await getRecord<FileMetaRecord>(stores.fileMetaStore, hash);
        for (const chatId of rec?.chats ?? []) affected.add(chatId);
        stores.filesStore.delete(hash);
        for (const m of draftMetas) {
            refs.push(
                ...(await reconcileChatFileRefs(stores, m.id, new Set([hash])))
            );
        }

        return { chatIds: [...affected], draftMetas, refs };
    });
}

export interface FileFacts {
    local: boolean;
    providerEntry?: ProviderFileEntry;
}

export function dbGetFileFacts(
    hashes: string[],
    provider: ProviderId
): Promise<Record<string, FileFacts>> {
    return withTransaction(
        [STORE_FILES, STORE_FILE_META],
        'readonly',
        async (tx) => {
            const filesStore = tx.objectStore(STORE_FILES);
            const fileMetaStore = tx.objectStore(STORE_FILE_META);
            const lookups = hashes.map((hash) => ({
                hash,
                blobKey: reqAsPromise(filesStore.getKey(hash)),
                rec: getRecord<FileMetaRecord>(fileMetaStore, hash),
            }));
            const facts: Record<string, FileFacts> = {};
            for (const lookup of lookups) {
                const blobKey = await lookup.blobKey;
                const entry = (await lookup.rec)?.providers[provider];
                facts[lookup.hash] = {
                    local: blobKey !== undefined,
                    ...(entry ? { providerEntry: entry } : {}),
                };
            }
            return facts;
        }
    );
}

export async function dbLookupProviderFileHashes(
    provider: ProviderId
): Promise<Map<string, string>> {
    const metas = await withTransaction(STORE_FILE_META, 'readonly', (tx) =>
        getAllRecords<FileMetaRecord>(tx.objectStore(STORE_FILE_META))
    );
    const byFileId = new Map<string, string>();
    for (const rec of metas) {
        const entry = rec.providers[provider];
        if (entry) byFileId.set(entry.fileId, rec.hash);
    }
    return byFileId;
}

async function getFileMeta(hash: string): Promise<FileMetaRecord | undefined> {
    return withTransaction(STORE_FILE_META, 'readonly', (tx) =>
        getRecord<FileMetaRecord>(tx.objectStore(STORE_FILE_META), hash)
    );
}

export async function dbLookupProviderFile(
    hash: string,
    provider: ProviderId
): Promise<ProviderFileEntry | undefined> {
    return (await getFileMeta(hash))?.providers[provider];
}

export async function dbFileHasChats(hash: string): Promise<boolean> {
    return ((await getFileMeta(hash))?.chats.length ?? 0) > 0;
}

export async function dbRecordProviderFile(
    hash: string,
    provider: ProviderId,
    entry: ProviderFileEntry,
    filename: string,
    mediaType: string
): Promise<void> {
    await withTransaction(STORE_FILE_META, 'readwrite', async (tx) => {
        const store = tx.objectStore(STORE_FILE_META);
        const existing = await getRecord<FileMetaRecord>(store, hash);
        const rec: FileMetaRecord = existing ?? {
            hash,
            filename,
            mediaType,
            chats: [],
            providers: {},
        };
        rec.providers[provider] = entry;
        if (!rec.filename) rec.filename = filename;
        if (!rec.mediaType) rec.mediaType = mediaType;
        store.put(rec);
    });
}

export async function dbForgetProviderFile(
    provider: ProviderId,
    fileId: string
): Promise<string[]> {
    const affected = new Set<string>();
    await withTransaction([STORE_FILE_META, STORE_FILES], 'readwrite', (tx) => {
        const filesStore = tx.objectStore(STORE_FILES);
        return forEachCursor<FileMetaRecord>(
            tx.objectStore(STORE_FILE_META).openCursor(),
            (rec, cursor) => {
                if (rec.providers[provider]?.fileId !== fileId) return;
                delete rec.providers[provider];
                if (rec.chats.length > 0) {
                    for (const chatId of rec.chats) affected.add(chatId);
                    cursor.update(rec);
                } else if (Object.keys(rec.providers).length === 0) {
                    cursor.delete();
                    filesStore.delete(rec.hash);
                } else {
                    cursor.update(rec);
                }
            }
        );
    });
    return [...affected];
}
