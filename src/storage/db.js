// §5.1 IndexedDB persistence for conversations, runs, operations, messages, findings and assets.
// Writes go through the service worker; the side panel only reads (and builds exports).

const DB_NAME = 'peermind';
const DB_VERSION = 1;

const STORES = {
  conversations: { keyPath: 'id' },
  runs: { keyPath: 'id', indexes: ['conversationId'] },
  operations: { keyPath: 'id', indexes: ['conversationId', 'runId'] },
  messages: { keyPath: 'id', indexes: ['conversationId'] },
  findings: { keyPath: 'key', indexes: ['conversationId'] }, // key = `${conversationId}:${id}`
  assets: { keyPath: 'key', indexes: ['conversationId'] },   // key = `${conversationId}:${id}`
  meta: { keyPath: 'key' },
};

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, def] of Object.entries(STORES)) {
        if (db.objectStoreNames.contains(name)) continue;
        const store = db.createObjectStore(name, { keyPath: def.keyPath });
        for (const idx of def.indexes || []) store.createIndex(idx, idx);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const promisify = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

/**
 * Run `fn(stores)` inside one transaction; resolves with fn's result once the transaction commits.
 * `stores` maps store name → small async API bound to the transaction.
 */
export async function tx(names, mode, fn) {
  const db = await openDb();
  const t = db.transaction(names, mode);
  const api = {};
  for (const n of names) {
    const s = t.objectStore(n);
    api[n] = {
      get: (k) => promisify(s.get(k)),
      put: (v) => promisify(s.put(v)),
      delete: (k) => promisify(s.delete(k)),
      all: () => promisify(s.getAll()),
      byIndex: (idx, v) => promisify(s.index(idx).getAll(v)),
      keysByIndex: (idx, v) => promisify(s.index(idx).getAllKeys(v)),
    };
  }
  const done = new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
  });
  let result;
  try {
    result = await fn(api);
  } catch (e) {
    try { t.abort(); } catch { /* already finished */ }
    throw e;
  }
  await done;
  return result;
}

export const get = (store, key) => tx([store], 'readonly', (s) => s[store].get(key));
export const put = (store, value) => tx([store], 'readwrite', (s) => s[store].put(value));
export const all = (store) => tx([store], 'readonly', (s) => s[store].all());
export const byIndex = (store, idx, v) => tx([store], 'readonly', (s) => s[store].byIndex(idx, v));

export const findingKey = (conversationId, id) => `${conversationId}:${id}`;

/** Everything belonging to one conversation, for the UI and export. */
export async function loadConversation(conversationId) {
  return tx(['conversations', 'runs', 'operations', 'messages', 'findings', 'assets'], 'readonly', async (s) => ({
    conversation: await s.conversations.get(conversationId),
    runs: (await s.runs.byIndex('conversationId', conversationId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    operations: (await s.operations.byIndex('conversationId', conversationId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    messages: (await s.messages.byIndex('conversationId', conversationId)).sort((a, b) => a.seq - b.seq),
    findings: (await s.findings.byIndex('conversationId', conversationId)).sort((a, b) => a.id.localeCompare(b.id)),
    assets: await s.assets.byIndex('conversationId', conversationId),
  }));
}

/** FR-054: delete one conversation and every associated record, including assets. */
export async function deleteConversation(conversationId) {
  const stores = ['conversations', 'runs', 'operations', 'messages', 'findings', 'assets'];
  return tx(stores, 'readwrite', async (s) => {
    await s.conversations.delete(conversationId);
    for (const n of stores.slice(1)) {
      for (const k of await s[n].keysByIndex('conversationId', conversationId)) await s[n].delete(k);
    }
  });
}
