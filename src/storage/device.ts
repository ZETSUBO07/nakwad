/** Storage features of the browser, each optional so the app degrades instead of failing. */

export interface StorageInfo {
  usedBytes: number | null;
  quotaBytes: number | null;
  persisted: boolean | null;
}

type StorageManagerLike = Pick<StorageManager, "estimate" | "persist" | "persisted">;
const manager = (): Partial<StorageManagerLike> | undefined => globalThis.navigator?.storage;

/**
 * Ask the browser not to clear the app's data under storage pressure.
 * Called after the first successful save, as the spec says. Returns whether it is granted.
 */
export async function requestPersistence(m: Partial<StorageManagerLike> | undefined = manager()): Promise<boolean> {
  try {
    if (!m?.persisted || !m.persist) return false;
    if (await m.persisted()) return true;
    return await m.persist();
  } catch {
    return false;
  }
}

export async function storageInfo(m: Partial<StorageManagerLike> | undefined = manager()): Promise<StorageInfo> {
  const info: StorageInfo = { usedBytes: null, quotaBytes: null, persisted: null };
  try {
    if (m?.estimate) {
      const e = await m.estimate();
      info.usedBytes = e.usage ?? null;
      info.quotaBytes = e.quota ?? null;
    }
    if (m?.persisted) info.persisted = await m.persisted();
  } catch { /* leave unknown */ }
  return info;
}

/** Space is low when less than this is left (warn before saves start failing). */
export const LOW_SPACE_BYTES = 200e6;
export const isLowOnSpace = (i: StorageInfo): boolean =>
  i.usedBytes !== null && i.quotaBytes !== null && i.quotaBytes - i.usedBytes < LOW_SPACE_BYTES;

export interface WorkLock {
  release(): void;
}

type LockManagerLike = Pick<LockManager, "request">;

/**
 * Hold a work so a second window or tab cannot edit it at the same time (Web Locks).
 * Resolves to null when another window already has it. Without Web Locks, editing is allowed.
 */
export function acquireWorkLock(workId: string, locks: LockManagerLike | undefined = globalThis.navigator?.locks): Promise<WorkLock | null> {
  if (!locks) return Promise.resolve({ release: () => undefined });
  return new Promise((resolve, reject) => {
    locks.request(`nakwad-work-${workId}`, { ifAvailable: true }, (lock) => {
      if (!lock) { resolve(null); return undefined; }
      return new Promise<void>((done) => resolve({ release: () => done() }));
    }).catch(reject);
  });
}
