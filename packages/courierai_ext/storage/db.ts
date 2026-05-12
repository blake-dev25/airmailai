import type { AttachmentRef, ChatMeta, StoredChat } from '@courier/shared';

const DB_NAME = 'courier_ai';
const DB_VERSION = 4;
const LOG = '[courier:ext]';

const STORE_MESSAGES = 'chat_messages';
const STORE_META = 'chat_meta';
const STORE_FILES = 'files';

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
            db.createObjectStore(STORE_MESSAGES, { keyPath: 'id' });
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

// Multiset of attachment-hash counts across all messages in a chat.
function refCounts(chat: StoredChat | null): Map<string, number> {
    const counts = new Map<string, number>();
    if (!chat) return counts;
    for (const msg of chat.messages) {
        for (const att of msg.attachments ?? []) {
            counts.set(att.hash, (counts.get(att.hash) ?? 0) + 1);
        }
    }
    return counts;
}

// Strip volatile/in-flight fields. Anything coming in from the web may carry a
// full Attachment (with `data`/`encodedSizeBytes`); IDB only stores the ref.
function toRef(att: AttachmentRef): AttachmentRef {
    return {
        hash: att.hash,
        name: att.name,
        mediaType: att.mediaType,
        sizeBytes: att.sizeBytes,
    };
}

function normalizeChat(chat: StoredChat): StoredChat {
    return {
        ...chat,
        messages: chat.messages.map((m) => ({
            role: m.role,
            content: m.content,
            ...(m.thinking ? { thinking: m.thinking } : {}),
            ...(m.attachments?.length
                ? { attachments: m.attachments.map(toRef) }
                : {}),
        })),
    };
}

// `freshBlobs` carries any newly-uploaded file bytes that aren't yet in the
// files store. On the turn-save path the ext extracts these from the inbound
// TurnStartRequest; on direct save_chat calls (edits, renames) it's empty.
export async function dbSaveChat(
    chat: StoredChat,
    meta: ChatMeta,
    freshBlobs?: Map<string, Blob>
): Promise<void> {
    console.log(
        LOG,
        'db: save chat',
        chat.id,
        `(${chat.messages.length} messages)`
    );
    const stored = normalizeChat(chat);
    const db = await getDb();
    const tx = db.transaction(
        [STORE_MESSAGES, STORE_META, STORE_FILES],
        'readwrite'
    );
    const messagesStore = tx.objectStore(STORE_MESSAGES);
    const metaStore = tx.objectStore(STORE_META);
    const filesStore = tx.objectStore(STORE_FILES);

    const prior = (await reqAsPromise(messagesStore.get(chat.id))) as
        | StoredChat
        | undefined;
    const priorCounts = refCounts(prior ?? null);
    const nextCounts = refCounts(stored);

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
            const next = existing.refCount + delta;
            if (next <= 0) {
                filesStore.delete(hash);
            } else {
                filesStore.put({ ...existing, refCount: next });
            }
            continue;
        }

        // No file record yet — must be a new ref. Need the blob from freshBlobs.
        const blob = freshBlobs?.get(hash);
        if (!blob) {
            console.error(LOG, 'db: missing blob for new attachment ref', hash);
            tx.abort();
            throw new Error(`Missing blob for attachment hash ${hash}`);
        }
        if (delta > 0) {
            filesStore.put({ hash, blob, refCount: delta });
        }
        // delta < 0 with no prior record is nonsensical — skip silently.
    }

    messagesStore.put(stored);
    metaStore.put(meta);
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

    const prior = (await reqAsPromise(messagesStore.get(chatId))) as
        | StoredChat
        | undefined;
    const counts = refCounts(prior ?? null);

    for (const [hash, count] of counts) {
        const existing = (await reqAsPromise(filesStore.get(hash))) as
            | FileRecord
            | undefined;
        if (!existing) continue;
        const next = existing.refCount - count;
        if (next <= 0) {
            filesStore.delete(hash);
        } else {
            filesStore.put({ ...existing, refCount: next });
        }
    }

    messagesStore.delete(chatId);
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

export async function dbLoadChats(): Promise<StoredChat[]> {
    const db = await getDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_MESSAGES, 'readonly');
        const req = tx.objectStore(STORE_MESSAGES).getAll();
        req.onsuccess = () => {
            const chats = req.result as StoredChat[];
            console.log(LOG, 'db: load chats', `${chats.length} chats`);
            resolve(chats);
        };
        req.onerror = () => reject(req.error);
    });
}

export async function dbLoadChatsByIds(ids: string[]): Promise<StoredChat[]> {
    if (ids.length === 0) return [];
    const db = await getDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_MESSAGES, 'readonly');
        const store = tx.objectStore(STORE_MESSAGES);
        const results: StoredChat[] = [];
        let pending = ids.length;
        for (const id of ids) {
            const req = store.get(id);
            req.onsuccess = () => {
                if (req.result) results.push(req.result as StoredChat);
                if (--pending === 0) resolve(results);
            };
            req.onerror = () => reject(req.error);
        }
    });
}

export async function dbLoadChat(chatId: string): Promise<StoredChat | null> {
    const db = await getDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_MESSAGES, 'readonly');
        const req = tx.objectStore(STORE_MESSAGES).get(chatId);
        req.onsuccess = () => {
            const chat = req.result as StoredChat | undefined;
            console.log(
                LOG,
                'db: load chat',
                chatId,
                chat ? 'found' : 'not found'
            );
            resolve(chat ?? null);
        };
        req.onerror = () => reject(req.error);
    });
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
