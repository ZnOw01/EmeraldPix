import { getErrorMessage } from "./utils";
import type {
	PersistedKey,
	PersistedState,
	StorageStrategy,
} from "./storage-strategies";
import {
	ChromeStorageStrategy,
	IndexedDbStrategy,
	PERSISTED_KEYS,
} from "./storage-strategies";

function logStorageWarning(scope: string, error: unknown): void {
	console.warn(`[PersistedStore] ${scope}: ${getErrorMessage(error)}`);
}

function arePersistedValuesEqual(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (left == null || right == null) return left === right;
	if (Array.isArray(left) || Array.isArray(right)) {
		if (
			!Array.isArray(left) ||
			!Array.isArray(right) ||
			left.length !== right.length
		) {
			return false;
		}
		return left.every((value, index) =>
			arePersistedValuesEqual(value, right[index]),
		);
	}
	if (typeof left !== "object" || typeof right !== "object") return false;

	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	if (leftKeys.length !== rightKeys.length) return false;
	for (const key of leftKeys) {
		if (!(key in (right as object))) return false;
		if (
			!arePersistedValuesEqual(
				(left as Record<string, unknown>)[key],
				(right as Record<string, unknown>)[key],
			)
		) {
			return false;
		}
	}
	return true;
}

// ---- PersistedStore (coordinator with dual persistence) ----

class PersistedStore {
	constructor(
		private primary: StorageStrategy,
		private mirror: StorageStrategy,
	) {}

	async read<K extends PersistedKey>(
		key: K,
	): Promise<PersistedState[K] | undefined> {
		let idbValue: PersistedState[K] | undefined;

		try {
			idbValue = await this.mirror.read(key);
		} catch (error) {
			logStorageWarning(`IndexedDB read failed for key "${key}"`, error);
		}

		try {
			const value = await this.primary.read(key);

			if (!arePersistedValuesEqual(idbValue, value)) {
				try {
					if (value === undefined) {
						await this.mirror.remove([key]);
					} else {
						await this.mirror.write({ [key]: value } as Pick<
							PersistedState,
							K
						>);
					}
				} catch (error) {
					logStorageWarning(`IndexedDB sync failed for key "${key}"`, error);
				}
			}

			return value;
		} catch (error) {
			logStorageWarning(
				`chrome.storage fallback read failed for key "${key}"`,
				error,
			);
		}

		return idbValue;
	}

	async write(values: Partial<PersistedState>): Promise<void> {
		try {
			await this.primary.write(values);
		} catch (error) {
			logStorageWarning("chrome.storage write failed", error);
			throw error;
		}

		try {
			await this.mirror.write(values);
		} catch (error) {
			logStorageWarning("IndexedDB mirror write failed", error);
		}
	}

	async clear(): Promise<void> {
		try {
			await this.primary.clear();
		} catch (error) {
			logStorageWarning("chrome.storage clear failed", error);
			throw error;
		}

		try {
			await this.mirror.clear();
		} catch (error) {
			logStorageWarning("IndexedDB clear failed", error);
		}
	}

	async remove(keys: PersistedKey[]): Promise<void> {
		try {
			await this.primary.remove(keys);
		} catch (error) {
			logStorageWarning("chrome.storage delete failed", error);
			throw error;
		}

		try {
			await this.mirror.remove(keys);
		} catch (error) {
			logStorageWarning("IndexedDB delete failed", error);
		}
	}
}

// ---- Singleton instance (production) ----

const defaultStore = new PersistedStore(
	new ChromeStorageStrategy(),
	new IndexedDbStrategy(),
);

// ---- Public API (unchanged) ----

export async function readPersistedValue<K extends PersistedKey>(
	key: K,
): Promise<PersistedState[K] | undefined> {
	return defaultStore.read(key);
}

export async function writePersistedValues(
	values: Partial<PersistedState>,
): Promise<void> {
	return defaultStore.write(values);
}

export async function clearPersistedValues(): Promise<void> {
	return defaultStore.clear();
}

export async function removePersistedValues(
	keys: PersistedKey[],
): Promise<void> {
	return defaultStore.remove(keys);
}

// Re-export for consumers
export { PERSISTED_KEYS, arePersistedValuesEqual };
export type { PersistedKey, PersistedState, StorageStrategy };
