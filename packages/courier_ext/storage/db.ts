import type { StoredChat } from '@courier/shared';

const DB_NAME = 'courier_ai';
const DB_VERSION = 1;
const LOG = '[courier:ext]';

let _db: IDBDatabase | null = null;

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			req.result.createObjectStore('chats', { keyPath: 'id' });
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

export async function dbSaveChat(chat: StoredChat): Promise<void> {
	console.log(
		LOG,
		'db: save chat',
		chat.id,
		`(${chat.messages.length} messages)`
	);
	const db = await getDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction('chats', 'readwrite');
		tx.objectStore('chats').put(chat);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

export async function dbDeleteChat(chatId: string): Promise<void> {
	console.log(LOG, 'db: delete chat', chatId);
	const db = await getDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction('chats', 'readwrite');
		tx.objectStore('chats').delete(chatId);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

export async function dbLoadChats(): Promise<StoredChat[]> {
	const db = await getDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction('chats', 'readonly');
		const req = tx.objectStore('chats').getAll();
		req.onsuccess = () => {
			const chats = req.result as StoredChat[];
			console.log(LOG, 'db: load chats', `${chats.length} chats`);
			resolve(chats);
		};
		req.onerror = () => reject(req.error);
	});
}
