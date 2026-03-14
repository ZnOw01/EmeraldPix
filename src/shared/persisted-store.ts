import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { CaptureOptions, DownloadOptions, ExportOptions } from './messages';
import { getErrorMessage } from './utils';

interface PersistedState {
  captureOptions: CaptureOptions;
  exportOptions: ExportOptions;
  downloadOptions: DownloadOptions;
}

type PersistedKey = keyof PersistedState;
export const PERSISTED_KEYS: PersistedKey[] = [
  'captureOptions',
  'exportOptions',
  'downloadOptions'
];

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

function arePersistedValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function syncIdbValue<K extends PersistedKey>(
  key: K,
  value: PersistedState[K] | undefined
): Promise<void> {
  if (value === undefined) {
    await deleteFromIdb([key]);
    return;
  }

  await writeToIdb({ [key]: value } as Pick<PersistedState, K>);
}

export async function readPersistedValue<K extends PersistedKey>(
  key: K
): Promise<PersistedState[K] | undefined> {
  let idbValue: PersistedState[K] | undefined;

  try {
    idbValue = await readFromIdb(key);
  } catch (error) {
    logStorageWarning(`IndexedDB read failed for key "${key}"`, error);
  }

  try {
    const result = await chrome.storage.local.get(key);
    const value = result[key] as PersistedState[K] | undefined;

    if (!arePersistedValuesEqual(idbValue, value)) {
      try {
        await syncIdbValue(key, value);
      } catch (error) {
        logStorageWarning(`IndexedDB sync failed for key "${key}"`, error);
      }
    }

    return value;
  } catch (error) {
    logStorageWarning(`chrome.storage fallback read failed for key "${key}"`, error);
  }

  return idbValue;
}

export async function writePersistedValues(values: Partial<PersistedState>): Promise<void> {
  try {
    await chrome.storage.local.set(values as Record<string, unknown>);
  } catch (error) {
    logStorageWarning('chrome.storage write failed', error);
    throw error;
  }

  try {
    await writeToIdb(values);
  } catch (error) {
    logStorageWarning('IndexedDB mirror write failed', error);
  }
}

export async function clearPersistedValues(): Promise<void> {
  try {
    await chrome.storage.local.remove(PERSISTED_KEYS);
  } catch (error) {
    logStorageWarning('chrome.storage clear failed', error);
    throw error;
  }

  try {
    await clearIdb();
  } catch (error) {
    logStorageWarning('IndexedDB clear failed', error);
  }
}

export async function removePersistedValues(keys: PersistedKey[]): Promise<void> {
  try {
    await chrome.storage.local.remove(keys);
  } catch (error) {
    logStorageWarning('chrome.storage delete failed', error);
    throw error;
  }

  try {
    await deleteFromIdb(keys);
  } catch (error) {
    logStorageWarning('IndexedDB delete failed', error);
  }
}
