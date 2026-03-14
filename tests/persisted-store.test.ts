import { beforeEach, describe, expect, it, vi } from 'vitest';

type StorageRecord = Record<string, unknown>;

const idbState = new Map<string, unknown>();

vi.mock('idb', () => ({
  openDB: vi.fn(async () => ({
    objectStoreNames: {
      contains: () => true
    },
    createObjectStore: vi.fn(),
    get: vi.fn(async (_storeName: string, key: string) => idbState.get(key)),
    clear: vi.fn(async () => {
      idbState.clear();
    }),
    transaction: vi.fn(() => ({
      store: {
        put: vi.fn(async (value: unknown, key: string) => {
          idbState.set(key, value);
        }),
        delete: vi.fn(async (key: string) => {
          idbState.delete(key);
        })
      },
      done: Promise.resolve()
    }))
  }))
}));

describe('persisted store', () => {
  let chromeState: StorageRecord;
  let removeCalls: unknown[][];

  beforeEach(() => {
    idbState.clear();
    chromeState = {};
    removeCalls = [];

    vi.resetModules();
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: chromeState[key] })),
          set: vi.fn(async (value: StorageRecord) => {
            chromeState = { ...chromeState, ...value };
          }),
          remove: vi.fn(async (keys: string | string[]) => {
            const normalized = Array.isArray(keys) ? keys : [keys];
            removeCalls.push(normalized);
            for (const key of normalized) {
              delete chromeState[key];
            }
          })
        }
      }
    });
  });

  it('treats chrome.storage as the source of truth and repairs stale IndexedDB values', async () => {
    idbState.set('exportOptions', { format: 'jpg', jpgQuality: 0.5 });
    chromeState.exportOptions = { format: 'png', jpgQuality: 1 };

    const { readPersistedValue } = await import('../src/shared/persisted-store');

    await expect(readPersistedValue('exportOptions')).resolves.toEqual({
      format: 'png',
      jpgQuality: 1
    });
    expect(idbState.get('exportOptions')).toEqual({ format: 'png', jpgQuality: 1 });
  });

  it('removes stale IndexedDB values when chrome.storage no longer has the key', async () => {
    idbState.set('downloadOptions', { askWhereToSave: true });

    const { readPersistedValue } = await import('../src/shared/persisted-store');

    await expect(readPersistedValue('downloadOptions')).resolves.toBeUndefined();
    expect(idbState.has('downloadOptions')).toBe(false);
  });

  it('only clears managed settings keys from chrome.storage', async () => {
    chromeState.captureOptions = { enableSmartScroll: true };
    chromeState.exportOptions = { format: 'png', jpgQuality: 1 };
    chromeState.downloadOptions = { askWhereToSave: false };
    chromeState['emeraldpix-theme'] = 'dark';

    const { clearPersistedValues, PERSISTED_KEYS } = await import('../src/shared/persisted-store');

    await clearPersistedValues();

    expect(removeCalls).toEqual([PERSISTED_KEYS]);
    expect(chromeState['emeraldpix-theme']).toBe('dark');
  });

  it('throws when the primary chrome.storage write fails', async () => {
    const chromeMock = chrome as unknown as {
      storage: {
        local: {
          set: ReturnType<typeof vi.fn>;
        };
      };
    };
    chromeMock.storage.local.set.mockRejectedValueOnce(new Error('storage write failed'));

    const { writePersistedValues } = await import('../src/shared/persisted-store');

    await expect(
      writePersistedValues({
        exportOptions: { format: 'pdf', jpgQuality: 1 }
      })
    ).rejects.toThrow('storage write failed');
    expect(idbState.has('exportOptions')).toBe(false);
  });
});
