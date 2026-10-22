import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, commit, derive } from "../../../src/core";
import { StorageError, asStorageError, migrateDoc, withoutHistory, type Store } from "../../../src/storage";
import { bytes, freshStore, png, sampleDoc } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;

async function withWork(store: Store) {
  const doc = sampleDoc();
  const meta = await store.createWork(doc, "Cat", 1000);
  await store.saveWork(meta.id, { doc, newImages: new Map([["I1", png()]]), now: 2000 });
  return { id: meta.id, doc };
}

const expectKind = async (p: Promise<unknown>, kind: StorageError["kind"]) => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(StorageError);
  expect((err as StorageError).kind).toBe(kind);
};

describe("gallery", () => {
  it("creates, lists newest first, renames, duplicates and deletes works", async () => {
    const store = await freshStore();
    const a = await store.createWork(sampleDoc(), "A", 1000);
    const b = await store.createWork(sampleDoc(), "B", 2000);
    expect((await store.listWorks()).map((m) => m.name)).toEqual(["B", "A"]);
    expect((await store.renameWork(a.id, "A2")).name).toBe("A2");
    await store.saveWork(a.id, { doc: sampleDoc(), newImages: new Map([["I1", png(7)]]), now: 3000 });
    const copy = await store.duplicateWork(a.id, "A2 copy", 4000);
    expect(copy.id).not.toBe(a.id);
    expect(await bytes(await store.db.get("blobs", `${copy.id}/I1`))).toEqual(await bytes(png(7)));
    await store.deleteWork(b.id);
    expect((await store.listWorks()).map((m) => m.name).sort()).toEqual(["A2", "A2 copy"]);
    store.close();
  });

  it("reports missing works instead of creating them", async () => {
    const store = await freshStore();
    await expectKind(store.renameWork("nope", "x"), "missing");
    await expectKind(store.duplicateWork("nope", "x", 1), "missing");
    await expectKind(store.saveWork("nope", { doc: sampleDoc(), now: 1 }), "missing");
    await expectKind(store.loadWork("nope", 1), "missing");
    await expectKind(store.closeWork("nope", sampleDoc(), 1), "missing");
    expect(await store.listWorks()).toEqual([]);
  });

  it("deleting a work removes its pictures, cached layers and session in one go", async () => {
    const store = await freshStore();
    const { id } = await withWork(store);
    await store.loadWork(id, 3000);
    await store.putRaster(id, "P1", "L1", 1, png());
    await store.deleteWork(id);
    expect(await store.db.count("blobs")).toBe(0);
    expect(await store.db.count("rasters")).toBe(0);
    expect(await store.db.count("sessions")).toBe(0);
    expect(await store.db.count("docs")).toBe(0);
  });
});

describe("saving", () => {
  it("saves the work, its new pictures and the gallery entry together", async () => {
    const store = await freshStore();
    const { id } = await withWork(store);
    const meta = (await store.listWorks())[0]!;
    expect(meta).toMatchObject({ id, updated: 2000, rev: 2, pages: 1 });
    expect(await store.db.get("blobs", `${id}/I1`)).toBeDefined();
    const thumb = png(9);
    const next = await store.saveWork(id, { doc: sampleDoc(), thumb, now: 5000 });
    expect(next.rev).toBe(3);
    expect(next.thumb).toBeDefined();
  });

  it("never writes an invalid work", async () => {
    const store = await freshStore();
    const { id } = await withWork(store);
    const bad = { ...sampleDoc(), paper: "not-a-colour" };
    await expectKind(store.saveWork(id, { doc: bad, now: 9000 }), "invalid");
    await expectKind(store.createWork(bad, "x", 9000), "invalid");
    expect((await store.listWorks())[0]!.updated).toBe(2000);
  });

  it("a save that fails part way changes nothing (one transaction)", async () => {
    const store = await freshStore();
    const { id } = await withWork(store);
    const before = await store.db.get("docs", id);
    const doc = commit(sampleDoc().pages[0]!, { type: "clear", layer: "L1" });
    const changed = { ...sampleDoc(), pages: [doc] };
    const notCloneable = (() => 1) as unknown as Blob;
    const err = await store.saveWork(id, { doc: changed, newImages: new Map([["I2", png()], ["I3", notCloneable]]), now: 9000 }).catch((e: unknown) => e);
    expect(err).toBeDefined();
    expect(await store.db.get("docs", id)).toEqual(before);
    expect(await store.db.get("blobs", `${id}/I2`)).toBeUndefined();
    expect((await store.listWorks())[0]!.updated).toBe(2000);
  });
});

describe("opening, closing and recovering history", () => {
  it("a work closed on purpose comes back without history and without unused pictures", async () => {
    const store = await freshStore();
    const { id, doc } = await withWork(store);
    await store.saveWork(id, { doc, newImages: new Map([["I9", png()]]), now: 2500 });
    const opened = await store.loadWork(id, 3000);
    expect(opened.recovered).toBe(false);
    const folded = await store.closeWork(id, opened.doc, 4000);
    expect(folded.pages[0]!.actions).toEqual([]);
    expect(derive(folded.pages[0]!)).toEqual(derive(doc.pages[0]!));
    expect(await store.db.count("sessions")).toBe(0);
    expect(await store.db.get("blobs", `${id}/I9`)).toBeUndefined();
    expect(await store.db.get("blobs", `${id}/I1`)).toBeDefined();
    expect((await store.loadWork(id, 5000)).recovered).toBe(false);
  });

  it("after a crash (no close), opening again recovers the undo history", async () => {
    const store = await freshStore();
    const { id } = await withWork(store);
    await store.loadWork(id, 3000);
    // the app dies here: no closeWork
    const again = await store.loadWork(id, 4000);
    expect(again.recovered).toBe(true);
    expect(again.doc.pages[0]!.actions.length).toBeGreaterThan(0);
    expect(again.images.get("I1")).toBeDefined();
  });

  it("start-up clean-up drops sessions of deleted works and folds history older than 7 days", async () => {
    const store = await freshStore();
    const fresh = await withWork(store);
    const old = await withWork(store);
    await store.loadWork(fresh.id, 10 * DAY);
    await store.loadWork(old.id, 1 * DAY);
    await store.db.put("sessions", { workId: "gone", opened: 0, lastSaved: 0 }, "gone");
    const r = await store.cleanupOnStart(10 * DAY + 1);
    expect(r).toEqual({ orphans: 1, expired: 1 });
    expect((await store.loadWork(old.id, 11 * DAY)).doc.pages[0]!.actions).toEqual([]);
    expect((await store.loadWork(fresh.id, 11 * DAY)).recovered).toBe(true);
  });

  it("never changes data it cannot read, during clean-up or opening", async () => {
    const store = await freshStore();
    const newer = await withWork(store);
    const broken = await withWork(store);
    const newerRaw = { ...(await store.db.get("docs", newer.id) as object), schema: SCHEMA_VERSION + 1 };
    await store.db.put("docs", newerRaw, newer.id);
    await store.db.put("docs", { schema: SCHEMA_VERSION, pages: "?" }, broken.id);
    await store.db.put("sessions", { workId: broken.id, opened: 0, lastSaved: 0 }, broken.id);
    await expectKind(store.loadWork(newer.id, 1), "newer");
    await expectKind(store.loadWork(broken.id, 1), "invalid");
    await store.cleanupOnStart(100 * DAY);
    expect(await store.db.get("docs", newer.id)).toEqual(newerRaw);
    expect(await store.db.get("docs", broken.id)).toEqual({ schema: SCHEMA_VERSION, pages: "?" });
  });

  it("withoutHistory folds every page and empties redo", () => {
    const doc = sampleDoc();
    doc.pages[0] = { ...doc.pages[0]!, redo: [{ type: "clear", layer: "L1" }] };
    const f = withoutHistory(doc);
    expect(f.pages[0]!.actions).toEqual([]);
    expect(f.pages[0]!.redo).toEqual([]);
  });
});

describe("cached layer pictures and fonts", () => {
  it("returns only cached layers from the current save", async () => {
    const store = await freshStore();
    await store.putRaster("w1", "P1", "L1", 3, png(1));
    await store.putRaster("w1", "P1", "L2", 2, png(2));
    await store.putRaster("w1", "P2", "L1", 3, png(3));
    expect([...(await store.getRasters("w1", "P1", 3)).keys()]).toEqual(["L1"]);
    await store.clearRasters("w1");
    expect(await store.db.count("rasters")).toBe(0);
  });

  it("keeps an existing font instead of replacing it", async () => {
    const store = await freshStore();
    expect(await store.putFont("My Font", png(1), 1)).toBe(true);
    expect(await store.putFont("My Font", png(2), 2)).toBe(false);
    expect(await bytes((await store.listFonts())[0]!.data)).toEqual(await bytes(png(1)));
    await store.deleteFont("My Font");
    expect(await store.listFonts()).toEqual([]);
  });
});

describe("errors and upgrades", () => {
  it("turns a full disk into a 'quota' error and leaves other errors alone", () => {
    const quota = Object.assign(new Error("full"), { name: "QuotaExceededError" });
    expect((asStorageError(quota) as StorageError).kind).toBe("quota");
    expect((asStorageError(Object.assign(new Error("x"), { name: "InvalidStateError" })) as StorageError).kind).toBe("unavailable");
    const other = new TypeError("bug");
    expect(asStorageError(other)).toBe(other);
    const s = new StorageError("missing", "m");
    expect(asStorageError(s)).toBe(s);
  });

  it("upgrades old formats step by step and refuses what it cannot read", () => {
    expect(migrateDoc(null)).toMatchObject({ ok: false, reason: "invalid" });
    expect(migrateDoc({})).toMatchObject({ ok: false, reason: "invalid" });
    expect(migrateDoc({ schema: SCHEMA_VERSION + 1 })).toMatchObject({ ok: false, reason: "newer" });
    expect(migrateDoc({ ...sampleDoc(), schema: 0 })).toMatchObject({ ok: false, reason: "invalid", errors: ["no upgrade from schema 0"] });
    const old = { ...sampleDoc(), schema: 0, paper: "WHITE" } as Record<string, unknown>;
    const up = migrateDoc(old, { 0: (d) => ({ ...d, paper: String(d.paper).toLowerCase() }) });
    expect(up).toMatchObject({ ok: true, migrated: true });
    expect(old.paper).toBe("WHITE");
    expect(migrateDoc(sampleDoc())).toMatchObject({ ok: true, migrated: false });
  });
});
