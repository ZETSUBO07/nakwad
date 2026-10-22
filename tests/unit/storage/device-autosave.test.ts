import { afterEach, describe, expect, it, vi } from "vitest";
import { AutoSaver, acquireWorkLock, isLowOnSpace, requestPersistence, storageInfo, type SaveStatus } from "../../../src/storage";

describe("persistent storage", () => {
  it("asks once and reports what the browser decided", async () => {
    const persist = vi.fn(async () => true);
    expect(await requestPersistence({ persisted: async () => false, persist })).toBe(true);
    expect(await requestPersistence({ persisted: async () => true, persist })).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(await requestPersistence(undefined)).toBe(false);
    expect(await requestPersistence({ persisted: async () => { throw new Error("x"); }, persist })).toBe(false);
  });

  it("reports space and warns when little is left", async () => {
    const info = await storageInfo({ estimate: async () => ({ usage: 950e6, quota: 1e9 }), persisted: async () => true });
    expect(info).toEqual({ usedBytes: 950e6, quotaBytes: 1e9, persisted: true });
    expect(isLowOnSpace(info)).toBe(true);
    expect(isLowOnSpace({ usedBytes: 1e6, quotaBytes: 1e9, persisted: false })).toBe(false);
    expect(await storageInfo(undefined)).toEqual({ usedBytes: null, quotaBytes: null, persisted: null });
    expect(await storageInfo({ estimate: async () => { throw new Error("x"); } })).toEqual({ usedBytes: null, quotaBytes: null, persisted: null });
  });
});

describe("one window per work (Web Locks)", () => {
  // a tiny stand-in for navigator.locks with ifAvailable
  const fakeLocks = () => {
    const held = new Set<string>();
    return {
      request: (name: string, _o: unknown, cb: (lock: object | null) => unknown) => {
        if (held.has(name)) return Promise.resolve(cb(null));
        held.add(name);
        return Promise.resolve(cb({ name })).then(() => { held.delete(name); });
      },
    } as unknown as LockManager;
  };

  it("lets the first window in and keeps the second out until released", async () => {
    const locks = fakeLocks();
    const first = await acquireWorkLock("w1", locks);
    expect(first).not.toBeNull();
    expect(await acquireWorkLock("w1", locks)).toBeNull();
    expect(await acquireWorkLock("w2", locks)).not.toBeNull();
    first!.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(await acquireWorkLock("w1", locks)).not.toBeNull();
  });

  it("allows editing when the browser has no Web Locks", async () => {
    const lock = await acquireWorkLock("w1", undefined);
    expect(lock).not.toBeNull();
    lock!.release();
  });
});

describe("autosave", () => {
  afterEach(() => { vi.useRealTimers(); });

  const setup = (save: () => Promise<void>) => {
    const doc = new EventTarget() as EventTarget & { visibilityState: DocumentVisibilityState };
    doc.visibilityState = "visible";
    const win = new EventTarget();
    const statuses: SaveStatus[] = [];
    const saver = new AutoSaver({ save, onStatus: (s) => statuses.push(s), delayMs: 1500, retryMs: 5000, events: { document: doc as unknown as Document, window: win as unknown as Window } });
    return { saver, doc, win, statuses };
  };

  it("saves 1.5 s after the last change, once", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => undefined);
    const { saver, statuses } = setup(save);
    saver.markDirty();
    await vi.advanceTimersByTimeAsync(1000);
    saver.markDirty();
    await vi.advanceTimersByTimeAsync(1400);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(save).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(["dirty", "dirty", "saving", "saved"]);
    expect(saver.state).toBe("saved");
    saver.dispose();
  });

  it("saves at once when the app is hidden or closed", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => undefined);
    const { saver, doc, win } = setup(save);
    saver.markDirty();
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(1);
    saver.markDirty();
    win.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(2);
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).toHaveBeenCalledTimes(2);
    saver.dispose();
  });

  it("never runs two saves at once; changes during a save are saved next", async () => {
    vi.useFakeTimers();
    let running = 0, maxRunning = 0;
    let finish: () => void = () => undefined;
    const save = vi.fn(() => new Promise<void>((r) => { running++; maxRunning = Math.max(maxRunning, running); finish = () => { running--; r(); }; }));
    const { saver } = setup(save);
    saver.markDirty();
    await vi.advanceTimersByTimeAsync(1500);
    expect(save).toHaveBeenCalledTimes(1);
    saver.markDirty();
    const flushed = saver.flush();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    finish();
    await flushed;
    expect(save).toHaveBeenCalledTimes(2);
    expect(maxRunning).toBe(1);
    saver.dispose();
  });

  it("retries after a failed save and reports the error", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockRejectedValueOnce(new Error("disk")).mockResolvedValue(undefined);
    const { saver, statuses } = setup(save);
    saver.markDirty();
    await vi.advanceTimersByTimeAsync(1500);
    expect(saver.state).toBe("error");
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).toHaveBeenCalledTimes(2);
    expect(statuses.at(-1)).toBe("saved");
    saver.dispose();
  });

  it("flush does nothing when everything is saved, and listeners go away on dispose", async () => {
    const save = vi.fn(async () => undefined);
    const { saver, win } = setup(save);
    await saver.flush();
    expect(save).not.toHaveBeenCalled();
    saver.dispose();
    saver.markDirty();
    saver.dispose();
    win.dispatchEvent(new Event("pagehide"));
    await Promise.resolve();
    expect(save).not.toHaveBeenCalled();
  });
});
