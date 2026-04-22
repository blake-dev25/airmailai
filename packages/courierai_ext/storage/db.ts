import type { ChatMeta, StoredChat } from '@courier/shared';

const DB_NAME = 'courier_ai';
const DB_VERSION = 3;
const LOG = '[courier:ext]';

let _db: IDBDatabase | null = null;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of Array.from(db.objectStoreNames)) {
        db.deleteObjectStore(name);
      }
      db.createObjectStore('chat_messages', { keyPath: 'id' });
      db.createObjectStore('chat_meta', { keyPath: 'id' });
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

export async function dbSaveChat(
  chat: StoredChat,
  meta: ChatMeta
): Promise<void> {
  console.log(
    LOG,
    'db: save chat',
    chat.id,
    `(${chat.messages.length} messages)`
  );
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['chat_messages', 'chat_meta'], 'readwrite');
    tx.objectStore('chat_messages').put(chat);
    tx.objectStore('chat_meta').put(meta);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function dbDeleteChat(chatId: string): Promise<void> {
  console.log(LOG, 'db: delete chat', chatId);
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['chat_messages', 'chat_meta'], 'readwrite');
    tx.objectStore('chat_messages').delete(chatId);
    tx.objectStore('chat_meta').delete(chatId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function dbClearChats(): Promise<void> {
  console.log(LOG, 'db: clear chats');
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['chat_messages', 'chat_meta'], 'readwrite');
    tx.objectStore('chat_messages').clear();
    tx.objectStore('chat_meta').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function dbLoadChatMetas(): Promise<ChatMeta[]> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('chat_meta', 'readonly');
    const req = tx.objectStore('chat_meta').getAll();
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
    const tx = db.transaction('chat_messages', 'readonly');
    const req = tx.objectStore('chat_messages').getAll();
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
    const tx = db.transaction('chat_messages', 'readonly');
    const store = tx.objectStore('chat_messages');
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
    const tx = db.transaction('chat_messages', 'readonly');
    const req = tx.objectStore('chat_messages').get(chatId);
    req.onsuccess = () => {
      const chat = req.result as StoredChat | undefined;
      console.log(LOG, 'db: load chat', chatId, chat ? 'found' : 'not found');
      resolve(chat ?? null);
    };
    req.onerror = () => reject(req.error);
  });
}
