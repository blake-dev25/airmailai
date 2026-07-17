import type {
    ChatMeta,
    CourierAIMessage,
    DraftAttachment,
    HydratedStoredMessage,
    LocalFileInfo,
    ProviderFileEntry,
    ProviderFileRef,
    StoredChat,
    StoredMessage,
} from '@courierai/shared';
import { log } from '../debug';
import { bytesToBase64 } from './encoding';

interface IdbUsage {
    chatHistoryBytes: number;
    filesBytes: number;
}

const DB_NAME = 'courierai';
const DB_VERSION = 14;

const STORE_MESSAGES = 'chat_messages';
const STORE_META = 'chat_meta';
const STORE_FILES = 'files';
const STORE_FILE_META = 'file_meta';
const INDEX_CHAT_ORDER = 'chat_order';

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
    providers: Record<string, ProviderFileEntry>;
}

interface FileStores {
    messagesStore: IDBObjectStore;
    chatMetaStore: IDBObjectStore;
    filesStore: IDBObjectStore;
    fileMetaStore: IDBObjectStore;
}

let _db: IDBDatabase | null = null;

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (event) => {
            const db = req.result;
            if (event.oldVersion < 14) {
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
            }
        };
        req.onsuccess = () => {
            log.info('IndexedDB opened');
            resolve(req.result);
        };
        req.onerror = () => reject(req.error);
    });
}

async function getDb(): Promise<IDBDatabase> {
    if (!_db) _db = await openDb();
    return _db;
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

function fileTx(db: IDBDatabase): { tx: IDBTransaction; stores: FileStores } {
    const tx = db.transaction(
        [STORE_MESSAGES, STORE_META, STORE_FILES, STORE_FILE_META],
        'readwrite'
    );
    return {
        tx,
        stores: {
            messagesStore: tx.objectStore(STORE_MESSAGES),
            chatMetaStore: tx.objectStore(STORE_META),
            filesStore: tx.objectStore(STORE_FILES),
            fileMetaStore: tx.objectStore(STORE_FILE_META),
        },
    };
}

function chatMessagesRange(chatId: string): IDBKeyRange {
    return IDBKeyRange.bound(
        [chatId, ''] as unknown as IDBValidKey,
        [chatId, KEY_MAX] as unknown as IDBValidKey
    );
}

function messageAttachmentHashes(msg: CourierAIMessage | null): string[] {
    if (!msg) return [];
    const hashes: string[] = [];
    for (const part of msg.parts) {
        if (part.type === 'file') hashes.push(part.hash);
    }
    return hashes;
}

function messageFileInfos(
    msg: CourierAIMessage
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
    return Object.entries(rec.providers).map(([providerId, entry]) => ({
        providerId,
        fileId: entry.fileId,
    }));
}

async function ensureFileRef(
    stores: FileStores,
    chatId: string,
    hash: string,
    filename: string,
    mediaType: string,
    freshBlob?: Blob
): Promise<void> {
    const existing = (await reqAsPromise(stores.fileMetaStore.get(hash))) as
        FileMetaRecord | undefined;
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
        const rec = (await reqAsPromise(stores.fileMetaStore.get(hash))) as
            FileMetaRecord | undefined;
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
    const cursorReq = stores.messagesStore.openCursor(
        chatMessagesRange(chatId)
    );
    await new Promise<void>((resolve, reject) => {
        cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (!cursor) {
                resolve();
                return;
            }
            const row = cursor.value as StoredMessage;
            for (const hash of messageAttachmentHashes(row.message)) {
                if (hashes.has(hash)) remaining.add(hash);
            }
            cursor.continue();
        };
        cursorReq.onerror = () => reject(cursorReq.error);
    });
    const meta = (await reqAsPromise(stores.chatMetaStore.get(chatId))) as
        ChatMeta | undefined;
    for (const d of meta?.draftAttachments ?? []) {
        if (hashes.has(d.hash)) remaining.add(d.hash);
    }
    const gone = [...hashes].filter((h) => !remaining.has(h));
    return unlistChatFromHashes(stores, chatId, gone);
}

function base64ToBlob(base64: string, mediaType: string): Blob {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mediaType });
}

function freshBlobsFromHydrated(msg: HydratedStoredMessage): Map<string, Blob> {
    const blobs = new Map<string, Blob>();
    if (!msg.freshBlobs) return blobs;
    for (const [hash, entry] of Object.entries(msg.freshBlobs)) {
        if (blobs.has(hash)) continue;
        blobs.set(hash, base64ToBlob(entry.base64, entry.mediaType));
    }
    return blobs;
}

export async function dbPutMessage(
    msg: HydratedStoredMessage
): Promise<ProviderFileRef[]> {
    log.info('db: put message', msg.chatId, msg.message.id);
    if (!Number.isFinite(msg.message.metadata?.createdAt)) {
        throw new Error(
            `Message ${msg.message.id} has no valid createdAt - refusing to persist`
        );
    }
    const freshBlobs = freshBlobsFromHydrated(msg);
    const db = await getDb();
    const { tx, stores } = fileTx(db);

    const meta = (await reqAsPromise(stores.chatMetaStore.get(msg.chatId))) as
        ChatMeta | undefined;
    if (!meta) {
        log.info('db: chat gone, skipping put', msg.chatId, msg.message.id);
        tx.abort();
        return [];
    }
    const msgCreatedAt = msg.message.metadata.createdAt;
    if (msgCreatedAt > (meta.lastMessageAt ?? 0)) {
        stores.chatMetaStore.put({ ...meta, lastMessageAt: msgCreatedAt });
    }

    const prior = (await reqAsPromise(
        stores.messagesStore.get([msg.chatId, msg.message.id])
    )) as StoredMessage | undefined;
    stores.messagesStore.put({ chatId: msg.chatId, message: msg.message });

    for (const [hash, info] of messageFileInfos(msg.message)) {
        await ensureFileRef(
            stores,
            msg.chatId,
            hash,
            info.filename,
            info.mediaType,
            freshBlobs.get(hash)
        );
    }

    const nextHashes = new Set(messageAttachmentHashes(msg.message));
    const removed = new Set(
        messageAttachmentHashes(prior?.message ?? null).filter(
            (h) => !nextHashes.has(h)
        )
    );
    const refs = await reconcileChatFileRefs(stores, msg.chatId, removed);

    await txDone(tx);
    return refs;
}

export async function dbDeleteMessage(
    chatId: string,
    messageId: string
): Promise<ProviderFileRef[]> {
    log.info('db: delete message', chatId, messageId);
    const db = await getDb();
    const { tx, stores } = fileTx(db);

    const prior = (await reqAsPromise(
        stores.messagesStore.get([chatId, messageId])
    )) as StoredMessage | undefined;
    if (!prior) {
        await txDone(tx);
        return [];
    }
    stores.messagesStore.delete([chatId, messageId]);
    const refs = await reconcileChatFileRefs(
        stores,
        chatId,
        new Set(messageAttachmentHashes(prior.message))
    );
    await txDone(tx);
    return refs;
}

export async function dbDeleteMessagesAfter(
    chatId: string,
    lastKeptId: string
): Promise<ProviderFileRef[]> {
    log.info('db: delete messages after', chatId, lastKeptId);
    const db = await getDb();
    const { tx, stores } = fileTx(db);

    const boundary = (await reqAsPromise(
        stores.messagesStore.get([chatId, lastKeptId])
    )) as StoredMessage | undefined;
    if (!boundary) {
        log.info('db: boundary message missing, nothing to truncate');
        await txDone(tx);
        return [];
    }
    const boundaryCreatedAt = boundary.message.metadata?.createdAt ?? 0;

    const index = stores.messagesStore.index(INDEX_CHAT_ORDER);
    const range = IDBKeyRange.bound(
        [
            chatId,
            boundaryCreatedAt,
            boundary.message.id,
        ] as unknown as IDBValidKey,
        [chatId, Number.POSITIVE_INFINITY, KEY_MAX] as unknown as IDBValidKey,
        true,
        false
    );
    const refs: ProviderFileRef[] = [];
    const removedHashes = new Set<string>();
    const cursorReq = index.openCursor(range);
    await new Promise<void>((resolve, reject) => {
        cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (!cursor) {
                resolve();
                return;
            }
            const row = cursor.value as StoredMessage;
            for (const hash of messageAttachmentHashes(row.message)) {
                removedHashes.add(hash);
            }
            cursor.delete();
            cursor.continue();
        };
        cursorReq.onerror = () => reject(cursorReq.error);
    });
    refs.push(...(await reconcileChatFileRefs(stores, chatId, removedHashes)));
    await txDone(tx);
    return refs;
}

export async function dbSaveMeta(meta: ChatMeta): Promise<void> {
    log.info('db: save meta', meta.id);
    const db = await getDb();
    const tx = db.transaction(STORE_META, 'readwrite');
    const store = tx.objectStore(STORE_META);
    const existing = (await reqAsPromise(store.get(meta.id))) as
        ChatMeta | undefined;
    const lastMessageAt = Math.max(
        existing?.lastMessageAt ?? 0,
        meta.lastMessageAt ?? 0
    );
    store.put({
        ...meta,
        ...(lastMessageAt ? { lastMessageAt } : {}),
        draftAttachments: existing?.draftAttachments,
        containerId: existing?.containerId,
        containerExpiresAt: existing?.containerExpiresAt,
        containerFileIds: existing?.containerFileIds,
    });
    await txDone(tx);
}

export async function dbGetMeta(chatId: string): Promise<ChatMeta | undefined> {
    const db = await getDb();
    const tx = db.transaction(STORE_META, 'readonly');
    return (await reqAsPromise(tx.objectStore(STORE_META).get(chatId))) as
        ChatMeta | undefined;
}

export async function dbSetContainer(
    chatId: string,
    containerId: string,
    containerExpiresAt: string | undefined,
    containerFileIds: string[] | undefined
): Promise<void> {
    log.info('db: set container', chatId, containerId);
    const db = await getDb();
    const tx = db.transaction(STORE_META, 'readwrite');
    const store = tx.objectStore(STORE_META);
    const meta = (await reqAsPromise(store.get(chatId))) as
        ChatMeta | undefined;
    if (!meta) {
        await txDone(tx);
        return;
    }
    store.put({ ...meta, containerId, containerExpiresAt, containerFileIds });
    await txDone(tx);
}

export async function dbStageDraftAttachment(
    chatId: string,
    attachment: DraftAttachment,
    base64: string
): Promise<void> {
    const hash = attachment.hash;
    log.info('db: stage draft attachment', chatId, hash);
    const db = await getDb();
    const { tx, stores } = fileTx(db);
    const meta = (await reqAsPromise(stores.chatMetaStore.get(chatId))) as
        ChatMeta | undefined;
    if (!meta) {
        tx.abort();
        throw new Error(`Chat ${chatId} not found for draft attachment`);
    }
    const drafts = meta.draftAttachments ?? [];
    if (!drafts.some((d) => d.hash === hash)) {
        await ensureFileRef(
            stores,
            chatId,
            hash,
            attachment.name,
            attachment.mediaType,
            base64ToBlob(base64, attachment.mediaType)
        );
        stores.chatMetaStore.put({
            ...meta,
            draftAttachments: [...drafts, attachment],
        });
    }
    await txDone(tx);
}

export async function dbRemoveDraftAttachment(
    chatId: string,
    key: string
): Promise<ProviderFileRef[]> {
    log.info('db: remove draft attachment', chatId, key);
    const db = await getDb();
    const { tx, stores } = fileTx(db);
    const meta = (await reqAsPromise(stores.chatMetaStore.get(chatId))) as
        ChatMeta | undefined;
    const target = meta?.draftAttachments?.find((d) => d.hash === key);
    if (!meta || !target) {
        await txDone(tx);
        return [];
    }
    stores.chatMetaStore.put({
        ...meta,
        draftAttachments: meta.draftAttachments!.filter((d) => d.hash !== key),
    });
    const refs = await reconcileChatFileRefs(
        stores,
        chatId,
        new Set([target.hash])
    );
    await txDone(tx);
    return refs;
}

export async function dbClearDraftAttachments(
    chatId: string
): Promise<ProviderFileRef[]> {
    log.info('db: clear draft attachments', chatId);
    const db = await getDb();
    const { tx, stores } = fileTx(db);
    const meta = (await reqAsPromise(stores.chatMetaStore.get(chatId))) as
        ChatMeta | undefined;
    if (!meta || !meta.draftAttachments?.length) {
        await txDone(tx);
        return [];
    }
    const hashes = new Set<string>();
    for (const d of meta.draftAttachments) {
        hashes.add(d.hash);
    }
    stores.chatMetaStore.put({ ...meta, draftAttachments: [] });
    const refs = await reconcileChatFileRefs(stores, chatId, hashes);
    await txDone(tx);
    return refs;
}

export async function dbDeleteChat(chatId: string): Promise<ProviderFileRef[]> {
    log.info('db: delete chat', chatId);
    const db = await getDb();
    const { tx, stores } = fileTx(db);
    const refs: ProviderFileRef[] = [];
    const hashes = new Set<string>();
    const meta = (await reqAsPromise(stores.chatMetaStore.get(chatId))) as
        ChatMeta | undefined;
    for (const d of meta?.draftAttachments ?? []) {
        hashes.add(d.hash);
    }
    const cursorReq = stores.messagesStore.openCursor(
        chatMessagesRange(chatId)
    );
    await new Promise<void>((resolve, reject) => {
        cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (!cursor) {
                resolve();
                return;
            }
            const row = cursor.value as StoredMessage;
            for (const hash of messageAttachmentHashes(row.message)) {
                hashes.add(hash);
            }
            cursor.delete();
            cursor.continue();
        };
        cursorReq.onerror = () => reject(cursorReq.error);
    });
    stores.chatMetaStore.delete(chatId);
    refs.push(...(await unlistChatFromHashes(stores, chatId, hashes)));
    await txDone(tx);
    return refs;
}

export async function dbClearChats(): Promise<void> {
    log.info('db: clear chats');
    const db = await getDb();
    const { tx, stores } = fileTx(db);
    stores.messagesStore.clear();
    stores.chatMetaStore.clear();
    stores.filesStore.clear();
    await new Promise<void>((resolve, reject) => {
        const req = stores.fileMetaStore.openCursor();
        req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) {
                resolve();
                return;
            }
            const rec = cursor.value as FileMetaRecord;
            if (Object.keys(rec.providers).length > 0) {
                cursor.update({ ...rec, chats: [] });
            } else {
                cursor.delete();
            }
            cursor.continue();
        };
        req.onerror = () => reject(req.error);
    });
    await txDone(tx);
}

export async function dbWipeAll(): Promise<void> {
    log.info('db: wipe all');
    const db = await getDb();
    const { tx, stores } = fileTx(db);
    stores.messagesStore.clear();
    stores.chatMetaStore.clear();
    stores.filesStore.clear();
    stores.fileMetaStore.clear();
    await txDone(tx);
}

export async function dbLoadChatMetas(): Promise<ChatMeta[]> {
    const db = await getDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_META, 'readonly');
        const req = tx.objectStore(STORE_META).getAll();
        req.onsuccess = () => {
            const metas = req.result as ChatMeta[];
            log.info('db: load chat metas', `${metas.length} chats`);
            resolve(metas);
        };
        req.onerror = () => reject(req.error);
    });
}

async function loadMessagesForChat(
    db: IDBDatabase,
    chatId: string
): Promise<StoredMessage[]> {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_MESSAGES, 'readonly');
        const index = tx.objectStore(STORE_MESSAGES).index(INDEX_CHAT_ORDER);
        const range = IDBKeyRange.bound(
            [chatId, Number.NEGATIVE_INFINITY, ''] as unknown as IDBValidKey,
            [
                chatId,
                Number.POSITIVE_INFINITY,
                KEY_MAX,
            ] as unknown as IDBValidKey
        );
        const req = index.getAll(range);
        req.onsuccess = () => resolve(req.result as StoredMessage[]);
        req.onerror = () => reject(req.error);
    });
}

export async function dbLoadChatsByIds(ids: string[]): Promise<StoredChat[]> {
    if (ids.length === 0) return [];
    const db = await getDb();
    const chats = await Promise.all(
        ids.map(async (id) => ({
            id,
            messages: await loadMessagesForChat(db, id),
        }))
    );
    log.info('db: load chats by ids', `${chats.length} chats`);
    return chats;
}

export async function dbLoadChat(chatId: string): Promise<StoredChat | null> {
    const db = await getDb();
    const tx = db.transaction(STORE_META, 'readonly');
    const meta = (await reqAsPromise(
        tx.objectStore(STORE_META).get(chatId)
    )) as ChatMeta | undefined;
    if (!meta) {
        log.info('db: load chat', chatId, 'not found');
        return null;
    }
    const messages = await loadMessagesForChat(db, chatId);
    log.info('db: load chat', chatId, `(${messages.length} messages)`);
    return { id: chatId, messages };
}

export async function dbGetStorageUsage(): Promise<IdbUsage> {
    const db = await getDb();
    let filesBytes = 0;
    const tx = db.transaction(STORE_FILES, 'readonly');
    const filesStore = tx.objectStore(STORE_FILES);
    await new Promise<void>((resolve, reject) => {
        const req = filesStore.openCursor();
        req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) {
                resolve();
                return;
            }
            filesBytes += (cursor.value as FileRecord).blob.size;
            cursor.continue();
        };
        req.onerror = () => reject(req.error);
    });
    await txDone(tx);

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

export async function dbGetFileBlobBase64(
    hash: string
): Promise<{ mediaType: string; base64: string } | null> {
    const blob = await dbGetFileBlob(hash);
    if (!blob) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { mediaType: blob.type, base64: bytesToBase64(bytes) };
}

export async function dbGetFileBlob(hash: string): Promise<Blob | null> {
    const db = await getDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_FILES, 'readonly');
        const req = tx.objectStore(STORE_FILES).get(hash);
        req.onsuccess = () => {
            const rec = req.result as FileRecord | undefined;
            resolve(rec?.blob ?? null);
        };
        req.onerror = () => reject(req.error);
    });
}

export async function dbListLocalFiles(): Promise<LocalFileInfo[]> {
    const db = await getDb();
    const tx = db.transaction([STORE_FILES, STORE_FILE_META], 'readonly');
    const records = (await reqAsPromise(
        tx.objectStore(STORE_FILES).getAll()
    )) as FileRecord[];
    const metas = (await reqAsPromise(
        tx.objectStore(STORE_FILE_META).getAll()
    )) as FileMetaRecord[];
    const metaByHash = new Map(metas.map((m) => [m.hash, m]));
    await txDone(tx);
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

export async function dbDeleteStoredFile(hash: string): Promise<string[]> {
    log.info('db: delete stored file', hash);
    const db = await getDb();
    const { tx, stores } = fileTx(db);
    const affected = new Set<string>();

    const metas = (await reqAsPromise(
        stores.chatMetaStore.getAll()
    )) as ChatMeta[];
    for (const m of metas) {
        const drafts = m.draftAttachments;
        if (!drafts?.length) continue;
        const keptDrafts = drafts.filter((d) => d.hash !== hash);
        if (keptDrafts.length === drafts.length) continue;
        stores.chatMetaStore.put({ ...m, draftAttachments: keptDrafts });
        affected.add(m.id);
    }

    const rec = (await reqAsPromise(stores.fileMetaStore.get(hash))) as
        FileMetaRecord | undefined;
    for (const chatId of rec?.chats ?? []) affected.add(chatId);
    stores.filesStore.delete(hash);

    await txDone(tx);
    return [...affected];
}

export interface FileFacts {
    local: boolean;
    providerEntry?: ProviderFileEntry;
}

export async function dbGetFileFacts(
    hashes: string[],
    provider: string
): Promise<Record<string, FileFacts>> {
    const db = await getDb();
    const tx = db.transaction([STORE_FILES, STORE_FILE_META], 'readonly');
    const filesStore = tx.objectStore(STORE_FILES);
    const fileMetaStore = tx.objectStore(STORE_FILE_META);
    const facts: Record<string, FileFacts> = {};
    for (const hash of hashes) {
        const blobKey = await reqAsPromise(filesStore.getKey(hash));
        const rec = (await reqAsPromise(fileMetaStore.get(hash))) as
            FileMetaRecord | undefined;
        const entry = rec?.providers[provider];
        facts[hash] = {
            local: blobKey !== undefined,
            ...(entry ? { providerEntry: entry } : {}),
        };
    }
    await txDone(tx);
    return facts;
}

export async function dbLookupProviderFileHashes(
    provider: string
): Promise<Map<string, string>> {
    const db = await getDb();
    const tx = db.transaction(STORE_FILE_META, 'readonly');
    const metas = (await reqAsPromise(
        tx.objectStore(STORE_FILE_META).getAll()
    )) as FileMetaRecord[];
    await txDone(tx);
    const byFileId = new Map<string, string>();
    for (const rec of metas) {
        const entry = rec.providers[provider];
        if (entry) byFileId.set(entry.fileId, rec.hash);
    }
    return byFileId;
}

export async function dbLookupProviderFile(
    hash: string,
    provider: string
): Promise<ProviderFileEntry | undefined> {
    const db = await getDb();
    const tx = db.transaction(STORE_FILE_META, 'readonly');
    const rec = (await reqAsPromise(
        tx.objectStore(STORE_FILE_META).get(hash)
    )) as FileMetaRecord | undefined;
    return rec?.providers[provider];
}

export async function dbRecordProviderFile(
    hash: string,
    provider: string,
    entry: ProviderFileEntry,
    filename: string,
    mediaType: string
): Promise<void> {
    const db = await getDb();
    const tx = db.transaction(STORE_FILE_META, 'readwrite');
    const store = tx.objectStore(STORE_FILE_META);
    const existing = (await reqAsPromise(store.get(hash))) as
        FileMetaRecord | undefined;
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
    await txDone(tx);
}

export async function dbForgetProviderFile(
    provider: string,
    fileId: string
): Promise<string[]> {
    const db = await getDb();
    const tx = db.transaction([STORE_FILE_META, STORE_FILES], 'readwrite');
    const store = tx.objectStore(STORE_FILE_META);
    const filesStore = tx.objectStore(STORE_FILES);
    const affected = new Set<string>();
    await new Promise<void>((resolve, reject) => {
        const req = store.openCursor();
        req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) {
                resolve();
                return;
            }
            const rec = cursor.value as FileMetaRecord;
            if (rec.providers[provider]?.fileId === fileId) {
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
            cursor.continue();
        };
        req.onerror = () => reject(req.error);
    });
    await txDone(tx);
    return [...affected];
}
