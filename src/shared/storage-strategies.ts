import type {
	CaptureOptions,
	DownloadOptions,
	ExportOptions,
} from "./messages";

export interface PersistedState {
	captureOptions: CaptureOptions;
	exportOptions: ExportOptions;
	downloadOptions: DownloadOptions;
}

export type PersistedKey = keyof PersistedState;
export const PERSISTED_KEYS: PersistedKey[] = [
	"captureOptions",
	"exportOptions",
	"downloadOptions",
] as const;

export interface StorageStrategy {
	read<K extends PersistedKey>(key: K): Promise<PersistedState[K] | undefined>;
	write(values: Partial<PersistedState>): Promise<void>;
	clear(): Promise<void>;
	remove(keys: PersistedKey[]): Promise<void>;
}

// ---- Chrome Storage Strategy ----

export class ChromeStorageStrategy implements StorageStrategy {
	async read<K extends PersistedKey>(
		key: K,
	): Promise<PersistedState[K] | undefined> {
		const result = await chrome.storage.local.get(key);
		return result[key] as PersistedState[K] | undefined;
	}

	async write(values: Partial<PersistedState>): Promise<void> {
		await chrome.storage.local.set(values as Record<string, unknown>);
	}

	async clear(): Promise<void> {
		await chrome.storage.local.remove(PERSISTED_KEYS);
	}

	async remove(keys: PersistedKey[]): Promise<void> {
		await chrome.storage.local.remove(keys);
	}
}

// ---- IndexedDB Strategy ----

import { openDB, type DBSchema, type IDBPDatabase } from "idb";

interface EmeraldPixDbSchema extends DBSchema {
	settings: {
		key: PersistedKey;
		value: PersistedState[PersistedKey];
	};
}

const DB_NAME = "emeraldpix-settings";
const STORE_NAME = "settings";
const DB_VERSION = 1;

export class IndexedDbStrategy implements StorageStrategy {
	private dbPromise: Promise<IDBPDatabase<EmeraldPixDbSchema>> | null = null;

	private async getDb(): Promise<IDBPDatabase<EmeraldPixDbSchema>> {
		if (!this.dbPromise) {
			this.dbPromise = openDB<EmeraldPixDbSchema>(DB_NAME, DB_VERSION, {
				upgrade(db) {
					if (!db.objectStoreNames.contains(STORE_NAME)) {
						db.createObjectStore(STORE_NAME);
					}
				},
			}).catch((error) => {
				this.dbPromise = null;
				throw error;
			});
		}
		return this.dbPromise;
	}

	async read<K extends PersistedKey>(
		key: K,
	): Promise<PersistedState[K] | undefined> {
		const db = await this.getDb();
		return (await db.get(STORE_NAME, key)) as PersistedState[K] | undefined;
	}

	async write(values: Partial<PersistedState>): Promise<void> {
		const entries = Object.entries(values) as Array<
			[PersistedKey, PersistedState[PersistedKey]]
		>;
		if (!entries.length) {
			return;
		}
		const db = await this.getDb();
		const tx = db.transaction(STORE_NAME, "readwrite");
		for (const [key, value] of entries) {
			await tx.store.put(value, key);
		}
		await tx.done;
	}

	async clear(): Promise<void> {
		const db = await this.getDb();
		await db.clear(STORE_NAME);
	}

	async remove(keys: PersistedKey[]): Promise<void> {
		if (!keys.length) {
			return;
		}
		const db = await this.getDb();
		const tx = db.transaction(STORE_NAME, "readwrite");
		for (const key of keys) {
			await tx.store.delete(key);
		}
		await tx.done;
	}
}
