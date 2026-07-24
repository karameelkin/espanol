// Tiny promise wrapper around IndexedDB: per-card FSRS state + meta (settings, daily new-card log).

const DB_NAME = 'spanish-srs';
const DB_VERSION = 1;

let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('cards')) {
        db.createObjectStore('cards', { keyPath: 'i' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'k' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        let result;
        Promise.resolve(fn(s)).then((r) => { result = r; });
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

function reqP(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export const db = {
  async allCards() {
    return tx('cards', 'readonly', (s) => reqP(s.getAll()));
  },
  async getCard(i) {
    return tx('cards', 'readonly', (s) => reqP(s.get(i)));
  },
  async putCard(card) {
    return tx('cards', 'readwrite', (s) => reqP(s.put(card)));
  },
  async getMeta(k, fallback = null) {
    const row = await tx('meta', 'readonly', (s) => reqP(s.get(k)));
    return row ? row.v : fallback;
  },
  async setMeta(k, v) {
    return tx('meta', 'readwrite', (s) => reqP(s.put({ k, v })));
  },
  async clearAll() {
    await tx('cards', 'readwrite', (s) => reqP(s.clear()));
    await tx('meta', 'readwrite', (s) => reqP(s.clear()));
  },
};
