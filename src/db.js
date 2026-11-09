// IndexedDB wrapper. Everything lives on the phone; use Settings > Backup to move it.

const DB_NAME = 'receipts-app';
const DB_VERSION = 1;
let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('receipts')) {
        const s = db.createObjectStore('receipts', { keyPath: 'id' });
        s.createIndex('date', 'date');
      }
      if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const db = {
  allReceipts: () => tx('receipts', 'readonly', (s) => s.getAll()),
  getReceipt: (id) => tx('receipts', 'readonly', (s) => s.get(id)),
  putReceipt: (r) => tx('receipts', 'readwrite', (s) => s.put(r)),
  deleteReceipt: (id) => tx('receipts', 'readwrite', (s) => s.delete(id)),
  getImage: (id) => tx('images', 'readonly', (s) => s.get(id)),
  putImage: (img) => tx('images', 'readwrite', (s) => s.put(img)),
  deleteImage: (id) => tx('images', 'readwrite', (s) => s.delete(id)),
  allImages: () => tx('images', 'readonly', (s) => s.getAll()),
  getSettings: () => tx('settings', 'readonly', (s) => s.get('settings')).then((row) => (row ? row.value : null)),
  putSettings: (value) => tx('settings', 'readwrite', (s) => s.put({ key: 'settings', value })),
  async clearAll() {
    await tx('receipts', 'readwrite', (s) => s.clear());
    await tx('images', 'readwrite', (s) => s.clear());
  },
};
