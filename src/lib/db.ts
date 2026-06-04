import type { NetworkEntry, PageRecord, PageTransition, ScanTask } from "../types";

const DB_NAME = "capability-discovery-assistant";
const DB_VERSION = 2;

type StoreName = "tasks" | "pages" | "network" | "transitions";

let dbPromise: Promise<IDBDatabase> | undefined;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("tasks")) {
        db.createObjectStore("tasks", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("pages")) {
        const store = db.createObjectStore("pages", { keyPath: "pageId" });
        store.createIndex("taskId", "taskId");
        store.createIndex("timestamp", "timestamp");
      }
      if (!db.objectStoreNames.contains("network")) {
        const store = db.createObjectStore("network", { keyPath: "id" });
        store.createIndex("pageId", "pageId");
        store.createIndex("timestamp", "timestamp");
      }
      if (!db.objectStoreNames.contains("transitions")) {
        const store = db.createObjectStore("transitions", { keyPath: "id" });
        store.createIndex("taskId", "taskId");
        store.createIndex("timestamp", "timestamp");
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}

async function tx<T>(storeName: StoreName, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    const request = action(store);
    let result: T | undefined;

    if (request) {
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => reject(request.error);
    }

    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
  });
}

export const db = {
  async putTask(task: ScanTask) {
    await tx("tasks", "readwrite", (store) => store.put(task));
  },
  async getTask(id: string) {
    return tx<ScanTask>("tasks", "readonly", (store) => store.get(id));
  },
  async listTasks() {
    return (await tx<ScanTask[]>("tasks", "readonly", (store) => store.getAll())) ?? [];
  },
  async getActiveTask() {
    const tasks = await this.listTasks();
    return tasks
      .filter((task) => task.status === "running" || task.status === "paused")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  },
  async putPage(page: PageRecord) {
    await tx("pages", "readwrite", (store) => store.put(page));
  },
  async getPage(pageId: string) {
    return tx<PageRecord>("pages", "readonly", (store) => store.get(pageId));
  },
  async listPages(taskId: string) {
    const database = await openDb();
    return new Promise<PageRecord[]>((resolve, reject) => {
      const transaction = database.transaction("pages", "readonly");
      const request = transaction.objectStore("pages").index("taskId").getAll(taskId);
      request.onsuccess = () => resolve(request.result.sort((a, b) => a.timestamp.localeCompare(b.timestamp)));
      request.onerror = () => reject(request.error);
    });
  },
  async putNetwork(entry: NetworkEntry) {
    await tx("network", "readwrite", (store) => store.put(entry));
  },
  async listNetwork(pageId: string) {
    const database = await openDb();
    return new Promise<NetworkEntry[]>((resolve, reject) => {
      const transaction = database.transaction("network", "readonly");
      const request = transaction.objectStore("network").index("pageId").getAll(pageId);
      request.onsuccess = () => resolve(request.result.sort((a, b) => a.timestamp.localeCompare(b.timestamp)));
      request.onerror = () => reject(request.error);
    });
  },
  async putTransition(transition: PageTransition) {
    await tx("transitions", "readwrite", (store) => store.put(transition));
  },
  async listTransitions(taskId: string) {
    const database = await openDb();
    return new Promise<PageTransition[]>((resolve, reject) => {
      const transaction = database.transaction("transitions", "readonly");
      const request = transaction.objectStore("transitions").index("taskId").getAll(taskId);
      request.onsuccess = () => resolve(request.result.sort((a, b) => a.timestamp.localeCompare(b.timestamp)));
      request.onerror = () => reject(request.error);
    });
  }
};
