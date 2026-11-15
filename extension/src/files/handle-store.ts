/**
 * Remembers the folder the user picked.
 *
 * A `FileSystemDirectoryHandle` is structured-cloneable but not JSON, so it
 * cannot live in `chrome.storage`; IndexedDB can hold it. The handle outlives
 * the page, the permission may not: after a browser restart Chrome can report
 * "prompt", and re-granting needs a user gesture (hence "Reconnect folder").
 */

const DB = "canvas-archiver";
const STORE = "handles";
const KEY = "download-root";
/** The HQ knowledge inbox is a separate folder from the browsing archive. */
export const INBOX_KEY = "ingest-inbox";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = fn(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function loadRoot(key = KEY): Promise<FileSystemDirectoryHandle | null> {
  try {
    return ((await run("readonly", (s) => s.get(key))) as FileSystemDirectoryHandle | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function saveRoot(handle: FileSystemDirectoryHandle, key = KEY): Promise<void> {
  await run("readwrite", (s) => s.put(handle, key));
}

export async function forgetRoot(key = KEY): Promise<void> {
  await run("readwrite", (s) => s.delete(key));
}

export type RootAccess = "granted" | "prompt" | "denied";

export async function rootAccess(handle: FileSystemDirectoryHandle): Promise<RootAccess> {
  return handle.queryPermission({ mode: "readwrite" });
}

/** Must be called from a click handler. */
export async function requestRootAccess(handle: FileSystemDirectoryHandle): Promise<RootAccess> {
  return handle.requestPermission({ mode: "readwrite" });
}

/** Must be called from a click handler. Throws AbortError if the user cancels. */
export function pickRoot(id = "canvas-archiver"): Promise<FileSystemDirectoryHandle> {
  return window.showDirectoryPicker({ id, mode: "readwrite" });
}
