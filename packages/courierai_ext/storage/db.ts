import type {
    ChatMeta,
    CourierUIMessage,
    HydratedStoredMessage,
    StoredChat,
    StoredMessage,
} from '@courier/shared';

interface IdbUsage {
    chatHistoryBytes: number;
    filesBytes: number;
}

const DB_NAME = 'courier_ai';
// Version bump: schema switched to UIMessage[]. Pre-migration data is
// dropped on first open (beta, no external users).
const DB_VERSION = 8;
const LOG = '[courier:ext]';

const STORE_MESSAGES = 'chat_messages';
const STORE_META = 'chat_meta';
const STORE_FILES = 'files';
const INDEX_CHAT_ORDER = 'chat_order';

// Content-addressed blob record. `refCount` tracks how many message
// attachments across all chats reference this hash; on save/delete we diff
// and GC when it hits zero.
interface FileRecord {
    hash: string;
    blob: Blob;
    refCount: number;
}

let _db: IDBDatabase | null = null;

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            // Alpha: nuke and recreate on every version bump.
            for (const name of Array.from(db.objectStoreNames)) {
                db.deleteObjectStore(name);
            }
            // Nested keyPaths reach into uiMessage.id / uiMessage.metadata.
            // IDB resolves dot-paths against the stored value.
            const messages = db.createObjectStore(STORE_MESSAGES, {
                keyPath: ['chatId', 'uiMessage.id'],
            });
            // Compound index for ordered load. uiMessage.id is the tiebreaker
            // for the (unlikely) case of two messages sharing a createdAt ms.
            messages.createIndex(
                INDEX_CHAT_ORDER,
                ['chatId', 'uiMessage.metadata.createdAt', 'uiMessage.id'],
                { unique: false }
            );
            db.createObjectStore(STORE_META, { keyPath: 'id' });
            db.createObjectStore(STORE_FILES, { keyPath: 'hash' });
        };
        req.onsuccess = () => {
            console.log(LOG, 'IndexedDB opened');
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

// Walk a UIMessage's parts and pull out every attachment hash referenced.
// Multiple `data-attachment` parts pointing at the same hash count once
// each — same dedup semantics as the old AttachmentRef[] shape.
function messageAttachmentHashes(msg: CourierUIMessage | null): string[] {
    if (!msg) return [];
    const hashes: string[] = [];
    for (const part of msg.parts) {
        if (part.type === 'data-attachment') {
            // Narrow via the CourierDataParts shape; the SDK's part union
            // widens `data` to unknown.
            const data = part.data as { hash: string };
            hashes.push(data.hash);
        }
    }
    return hashes;
}

function messageRefCounts(msg: CourierUIMessage | null): Map<string, number> {
    const counts = new Map<string, number>();
    for (const hash of messageAttachmentHashes(msg)) {
        counts.set(hash, (counts.get(hash) ?? 0) + 1);
    }
    return counts;
}

// Apply attachment refcount diffs for one message change inside an open
// transaction. `freshBlobs` carries bytes for any new hashes not yet in the
// files store; missing-blob for a positive delta aborts the tx loudly.
async function applyAttachmentDelta(
    filesStore: IDBObjectStore,
    prior: CourierUIMessage | null,
    next: CourierUIMessage | null,
    freshBlobs?: Map<string, Blob>
): Promise<void> {
    const priorCounts = messageRefCounts(prior);
    const nextCounts = messageRefCounts(next);
    const touched = new Set<string>([
        ...priorCounts.keys(),
        ...nextCounts.keys(),
    ]);
    for (const hash of touched) {
        const delta =
            (nextCounts.get(hash) ?? 0) - (priorCounts.get(hash) ?? 0);
        if (delta === 0) continue;
        const existing = (await reqAsPromise(filesStore.get(hash))) as
            | FileRecord
            | undefined;
        if (existing) {
            const refCount = existing.refCount + delta;
            if (refCount <= 0) {
                filesStore.delete(hash);
            } else {
                filesStore.put({ ...existing, refCount });
            }
            continue;
        }
        // No prior file record — must be a new ref. Need the blob in freshBlobs.
        if (delta > 0) {
            const blob = freshBlobs?.get(hash);
            if (!blob) {
                throw new Error(
                    `Missing blob for attachment hash ${hash} — refusing to persist`
                );
            }
            filesStore.put({ hash, blob, refCount: delta });
        }
        // delta < 0 with no prior record is nonsensical — skip silently.
    }
}

function freshBlobsFromHydrated(msg: HydratedStoredMessage): Map<string, Blob> {
    const blobs = new Map<string, Blob>();
    if (!msg.freshBlobs) return blobs;
    for (const [hash, entry] of Object.entries(msg.freshBlobs)) {
        if (blobs.has(hash)) continue;
        const binary = atob(entry.base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        blobs.set(hash, new Blob([bytes], { type: entry.mediaType }));
    }
    return blobs;
}

// Upsert one message. Diff'd attachment refs are reconciled in the same
// transaction so the files store can't drift if the tx aborts.
export async function dbPutMessage(msg: HydratedStoredMessage): Promise<void> {
    console.log(LOG, 'db: put message', msg.chatId, msg.uiMessage.id);
    const freshBlobs = freshBlobsFromHydrated(msg);
    const db = await getDb();
    const tx = db.transaction(
        [STORE_MESSAGES, STORE_META, STORE_FILES],
        'readwrite'
    );
    const messagesStore = tx.objectStore(STORE_MESSAGES);
    const metaStore = tx.objectStore(STORE_META);
    const filesStore = tx.objectStore(STORE_FILES);

    // Refuse to orphan a message under a deleted chat. Same-tx read gives
    // us a consistent snapshot — a concurrent delete_chat either landed
    // before this tx (we see no meta and abort) or after (we wrote a row,
    // delete_chat will cascade and remove it).
    const meta = (await reqAsPromise(metaStore.get(msg.chatId))) as
        | ChatMeta
        | undefined;
    if (!meta) {
        console.log(
            LOG,
            'db: chat gone, skipping put',
            msg.chatId,
            msg.uiMessage.id
        );
        tx.abort();
        return;
    }

    const prior = (await reqAsPromise(
        messagesStore.get([msg.chatId, msg.uiMessage.id])
    )) as StoredMessage | undefined;
    const next: StoredMessage = {
        chatId: msg.chatId,
        uiMessage: msg.uiMessage,
    };
    await applyAttachmentDelta(
        filesStore,
        prior?.uiMessage ?? null,
        next.uiMessage,
        freshBlobs
    );
    messagesStore.put(next);
    await txDone(tx);
}

export async function dbDeleteMessage(
    chatId: string,
    messageId: string
): Promise<void> {
    console.log(LOG, 'db: delete message', chatId, messageId);
    const db = await getDb();
    const tx = db.transaction([STORE_MESSAGES, STORE_FILES], 'readwrite');
    const messagesStore = tx.objectStore(STORE_MESSAGES);
    const filesStore = tx.objectStore(STORE_FILES);

    const prior = (await reqAsPromise(
        messagesStore.get([chatId, messageId])
    )) as StoredMessage | undefined;
    if (!prior) {
        await txDone(tx);
        return;
    }
    await applyAttachmentDelta(filesStore, prior.uiMessage, null);
    messagesStore.delete([chatId, messageId]);
    await txDone(tx);
}

// Truncate everything after a given message (exclusive). Used by retry-with-
// edit: web sends the id of the last user message to keep; we delete every
// message in the chat with a strictly greater createdAt.
export async function dbDeleteMessagesAfter(
    chatId: string,
    lastKeptId: string
): Promise<void> {
    console.log(LOG, 'db: delete messages after', chatId, lastKeptId);
    const db = await getDb();
    const tx = db.transaction([STORE_MESSAGES, STORE_FILES], 'readwrite');
    const messagesStore = tx.objectStore(STORE_MESSAGES);
    const filesStore = tx.objectStore(STORE_FILES);

    const boundary = (await reqAsPromise(
        messagesStore.get([chatId, lastKeptId])
    )) as StoredMessage | undefined;
    if (!boundary) {
        console.log(LOG, 'db: boundary message missing, nothing to truncate');
        await txDone(tx);
        return;
    }
    const boundaryCreatedAt = boundary.uiMessage.metadata?.createdAt ?? 0;

    const index = messagesStore.index(INDEX_CHAT_ORDER);
    const lowerExclusive = [
        chatId,
        boundaryCreatedAt,
        boundary.uiMessage.id,
    ] as const;
    // [chatId, createdAt, id] > boundary triple. IDBKeyRange.bound with
    // open lower bound gives us strictly-after.
    const range = IDBKeyRange.bound(
        lowerExclusive as unknown as IDBValidKey,
        [chatId, Number.POSITIVE_INFINITY, '￿'] as unknown as IDBValidKey,
        true,
        false
    );
    const cursorReq = index.openCursor(range);
    await new Promise<void>((resolve, reject) => {
        cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (!cursor) {
                resolve();
                return;
            }
            const row = cursor.value as StoredMessage;
            // Refcount cleanup happens inline; can't await inside the
            // cursor callback without losing position, so we kick off and
            // continue — the transaction won't commit until everything
            // queued resolves.
            void applyAttachmentDelta(filesStore, row.uiMessage, null).catch(
                reject
            );
            cursor.delete();
            cursor.continue();
        };
        cursorReq.onerror = () => reject(cursorReq.error);
    });
    await txDone(tx);
}

export async function dbSaveMeta(meta: ChatMeta): Promise<void> {
    console.log(LOG, 'db: save meta', meta.id);
    const db = await getDb();
    const tx = db.transaction(STORE_META, 'readwrite');
    tx.objectStore(STORE_META).put(meta);
    await txDone(tx);
}

export async function dbDeleteChat(chatId: string): Promise<void> {
    console.log(LOG, 'db: delete chat', chatId);
    const db = await getDb();
    const tx = db.transaction(
        [STORE_MESSAGES, STORE_META, STORE_FILES],
        'readwrite'
    );
    const messagesStore = tx.objectStore(STORE_MESSAGES);
    const metaStore = tx.objectStore(STORE_META);
    const filesStore = tx.objectStore(STORE_FILES);

    // Cursor over every message row for this chat; decrement refcounts and
    // delete each row in the same tx.
    const range = IDBKeyRange.bound(
        [chatId, ''] as unknown as IDBValidKey,
        [chatId, '￿'] as unknown as IDBValidKey
    );
    const cursorReq = messagesStore.openCursor(range);
    await new Promise<void>((resolve, reject) => {
        cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (!cursor) {
                resolve();
                return;
            }
            const row = cursor.value as StoredMessage;
            void applyAttachmentDelta(filesStore, row.uiMessage, null).catch(
                reject
            );
            cursor.delete();
            cursor.continue();
        };
        cursorReq.onerror = () => reject(cursorReq.error);
    });
    metaStore.delete(chatId);
    await txDone(tx);
}

export async function dbClearChats(): Promise<void> {
    console.log(LOG, 'db: clear chats');
    const db = await getDb();
    const tx = db.transaction(
        [STORE_MESSAGES, STORE_META, STORE_FILES],
        'readwrite'
    );
    tx.objectStore(STORE_MESSAGES).clear();
    tx.objectStore(STORE_META).clear();
    tx.objectStore(STORE_FILES).clear();
    await txDone(tx);
}

export async function dbLoadChatMetas(): Promise<ChatMeta[]> {
    const db = await getDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_META, 'readonly');
        const req = tx.objectStore(STORE_META).getAll();
        req.onsuccess = () => {
            const metas = req.result as ChatMeta[];
            console.log(LOG, 'db: load chat metas', `${metas.length} chats`);
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
            [chatId, Number.POSITIVE_INFINITY, '￿'] as unknown as IDBValidKey
        );
        const req = index.getAll(range);
        req.onsuccess = () => resolve(req.result as StoredMessage[]);
        req.onerror = () => reject(req.error);
    });
}

export async function dbLoadChats(): Promise<StoredChat[]> {
    const db = await getDb();
    const metas = await dbLoadChatMetas();
    const chats = await Promise.all(
        metas.map(async (meta) => ({
            id: meta.id,
            messages: await loadMessagesForChat(db, meta.id),
        }))
    );
    console.log(LOG, 'db: load chats', `${chats.length} chats`);
    return chats;
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
    console.log(LOG, 'db: load chats by ids', `${chats.length} chats`);
    return chats;
}

export async function dbLoadChat(chatId: string): Promise<StoredChat | null> {
    const db = await getDb();
    const tx = db.transaction(STORE_META, 'readonly');
    const meta = (await reqAsPromise(
        tx.objectStore(STORE_META).get(chatId)
    )) as ChatMeta | undefined;
    if (!meta) {
        console.log(LOG, 'db: load chat', chatId, 'not found');
        return null;
    }
    const messages = await loadMessagesForChat(db, chatId);
    console.log(LOG, 'db: load chat', chatId, `(${messages.length} messages)`);
    return { id: chatId, messages };
}

// Per-store byte estimates for the Settings → Storage panel. Chat history is
// JSON-serialized length per row (not the on-disk structured-clone size, but
// the standard practical estimate). Files use Blob.size — metadata, doesn't
// read bytes off disk. One readonly tx so all three counts see a consistent
// snapshot.
export async function dbGetStorageUsage(): Promise<IdbUsage> {
    const db = await getDb();
    const tx = db.transaction(
        [STORE_MESSAGES, STORE_META, STORE_FILES],
        'readonly'
    );
    let chatHistoryBytes = 0;
    let filesBytes = 0;

    const sumCursor = (
        store: IDBObjectStore,
        onRow: (row: unknown) => void
    ): Promise<void> =>
        new Promise((resolve, reject) => {
            const req = store.openCursor();
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor) {
                    resolve();
                    return;
                }
                onRow(cursor.value);
                cursor.continue();
            };
            req.onerror = () => reject(req.error);
        });

    await Promise.all([
        sumCursor(tx.objectStore(STORE_MESSAGES), (row) => {
            chatHistoryBytes += JSON.stringify(row).length;
        }),
        sumCursor(tx.objectStore(STORE_META), (row) => {
            chatHistoryBytes += JSON.stringify(row).length;
        }),
        sumCursor(tx.objectStore(STORE_FILES), (row) => {
            filesBytes += (row as FileRecord).blob.size;
        }),
    ]);
    await txDone(tx);
    console.log(LOG, 'db: storage usage', { chatHistoryBytes, filesBytes });
    return { chatHistoryBytes, filesBytes };
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
