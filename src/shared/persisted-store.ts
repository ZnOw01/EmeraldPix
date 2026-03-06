import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  CaptureOptions,
  DownloadOptions,
  ExportOptions
} from './messages';

interface PersistedState {
  captureOptions: CaptureOptions;
  exportOptions: ExportOptions;
  downloadOptions: DownloadOptions;
}

type PersistedKey = keyof PersistedState;

interface EmeraldPixDbSchema extends DBSchema {
  settings: {
    key: PersistedKey;
    value: PersistedState[PersistedKey];
  };
}

const DB_NAME = 'emeraldpix-settings';
const STORE_NAME = 'settings';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<EmeraldPixDbSchema>> | null = null;

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error ?? 'Unknown error');
}

function logStorageWarning(scope: string, error: unknown): void {
  console.warn(`[PersistedStore] ${scope}: ${getErrorMessage(error)}`);
}

function getDb(): Promise<IDBPDatabase<EmeraldPixDbSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<EmeraldPixDbSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      }
    });
  }
  return dbPromise;
}

async function readFromIdb<K extends PersistedKey>(key: K): Promise<PersistedState[K] | undefined> {
  const db = await getDb();
  return (await db.get(STORE_NAME, key)) as PersistedState[K] | undefined;
}

async function writeToIdb(values: Partial<PersistedState>): Promise<void> {
  const entries = Object.entries(values) as Array<[PersistedKey, PersistedState[PersistedKey]]>;
  if (!entries.length) {
    return;
  }
  const db = await getDb();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  for (const [key, value] of entries) {
    await tx.store.put(value, key);
  }
  await tx.done;
}

async function clearIdb(): Promise<void> {
  const db = await getDb();
  await db.clear(STORE_NAME);
}

async function deleteFromIdb(keys: PersistedKey[]): Promise<void> {
  if (!keys.length) {
    return;
  }

  const db = await getDb();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  for (const key of keys) {
    await tx.store.delete(key);
  }
  await tx.done;
}

export async function readPersistedValue<K extends PersistedKey>(
  key: K
): Promise<PersistedState[K] | undefined> {
  try {
    const value = await readFromIdb(key);
    if (value !== undefined) {
      return value;
    }
  } catch (error) {
    logStorageWarning(`IndexedDB read failed for key "${key}"`, error);
  }

  return undefined;
}

export async function writePersistedValues(values: Partial<PersistedState>): Promise<void> {
  let idbWriteOk = false;

  try {
    await writeToIdb(values);
    idbWriteOk = true;
  } catch (error) {
    logStorageWarning('IndexedDB write failed', error);
  }

  try {
    await chrome.storage.local.set(values as Record<string, unknown>);
  } catch (error) {
    logStorageWarning('chrome.storage mirror write failed', error);
    if (!idbWriteOk) {
      throw error;
    }
  }
}

export async function clearPersistedValues(): Promise<void> {
  let idbClearOk = false;

  try {
    await clearIdb();
    idbClearOk = true;
  } catch (error) {
    logStorageWarning('IndexedDB clear failed', error);
  }

  try {
    await chrome.storage.local.clear();
  } catch (error) {
    logStorageWarning('chrome.storage clear failed', error);
    if (!idbClearOk) {
      throw error;
    }
  }
}

export async function removePersistedValues(keys: PersistedKey[]): Promise<void> {
  let idbDeleteOk = false;

  try {
    await deleteFromIdb(keys);
    idbDeleteOk = true;
  } catch (error) {
    logStorageWarning('IndexedDB delete failed', error);
  }

  try {
    await chrome.storage.local.remove(keys);
  } catch (error) {
    logStorageWarning('chrome.storage delete failed', error);
    if (!idbDeleteOk) {
      throw error;
    }
  }
}
