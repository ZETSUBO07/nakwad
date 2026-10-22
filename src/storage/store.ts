import { openDB, type IDBPTransaction, type StoreNames } from "idb";
import { fold, imagesInUse, validateDoc, type WorkDoc } from "../core";
import { StorageError, asStorageError } from "./errors";
import { migrateDoc } from "./migrate";
import { DB_NAME, DB_VERSION, prefixRange, upgrade, type DB, type FontRecord, type NakwadDB, type WorkMeta } from "./schema";

type StoreName = StoreNames<NakwadDB>;
type Tx = IDBPTransaction<NakwadDB, StoreName[], "readwrite">;

/** Undo history left behind by a crash is kept this long, then folded away (spec: 7 days). */
export const RECOVERY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface LoadedWork {
  meta: WorkMeta;
  doc: WorkDoc;
  images: Map<string, Blob>;
  /** true when the work was not closed properly last time and its undo history came back */
  recovered: boolean;
  /** true when the stored data was upgraded from an older format (it is saved back on the next save) */
  migrated: boolean;
}

export interface SaveInput {
  doc: WorkDoc;
  /** pictures added since the last save; earlier ones are already stored */
  newImages?: ReadonlyMap<string, Blob>;
  thumb?: Blob;
  now: number;
}

const blobKey = (workId: string, imageId: string) => `${workId}/${imageId}`;

/** A new, hard-to-guess work id such as "w1k2j3h4-9f2c". */
export function newWorkId(now: number): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return `w${now.toString(36)}-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** The work with every page's undo history folded into it (what "closing" a work keeps). */
export function withoutHistory(doc: WorkDoc): WorkDoc {
  return { ...doc, pages: doc.pages.map((p) => ({ ...fold(p, p.actions.length), redo: [] })) };
}

const hasHistory = (doc: WorkDoc) => doc.pages.some((p) => p.actions.length > 0 || p.redo.length > 0);

/** Everything the app keeps on the device, behind one IndexedDB database. */
export class Store {
  private constructor(readonly db: DB) {}

  static async open(name: string = DB_NAME): Promise<Store> {
    try {
      const db = await openDB<NakwadDB>(name, DB_VERSION, { upgrade: (d, oldVersion) => upgrade(d, oldVersion) });
      return new Store(db);
    } catch (err) {
      const e = asStorageError(err);
      throw e instanceof StorageError ? e : new StorageError("unavailable", String(err));
    }
  }

  close(): void {
    this.db.close();
  }

  // ---------- gallery ----------

  async listWorks(): Promise<WorkMeta[]> {
    const all = await this.db.getAll("works");
    return all.sort((a, b) => b.updated - a.updated);
  }

  async createWork(doc: WorkDoc, name: string, now: number): Promise<WorkMeta> {
    const checked = validateDoc(doc);
    if (!checked.ok) throw new StorageError("invalid", "refusing to store an invalid work", checked.errors);
    const meta: WorkMeta = { id: newWorkId(now), name, created: now, updated: now, pages: doc.pages.length, rev: 1 };
    await this.run(["works", "docs"], async (tx) => {
      await tx.objectStore("works").add(meta);
      await tx.objectStore("docs").add(doc, meta.id);
    });
    return meta;
  }

  async renameWork(id: string, name: string): Promise<WorkMeta> {
    return this.run(["works"], async (tx) => {
      const meta = await tx.objectStore("works").get(id);
      if (!meta) throw new StorageError("missing", `work ${id} not found`);
      const next = { ...meta, name };
      await tx.objectStore("works").put(next);
      return next;
    });
  }

  /** Copy a work with its pictures; history is copied too, the open session is not. */
  async duplicateWork(id: string, name: string, now: number): Promise<WorkMeta> {
    return this.run(["works", "docs", "blobs"], async (tx) => {
      const meta = await tx.objectStore("works").get(id);
      const doc = await tx.objectStore("docs").get(id);
      if (!meta || doc === undefined) throw new StorageError("missing", `work ${id} not found`);
      const blobs = tx.objectStore("blobs");
      const keys = await blobs.getAllKeys(prefixRange(id + "/"));
      const values = await blobs.getAll(prefixRange(id + "/"));
      const copy: WorkMeta = { ...meta, id: newWorkId(now), name, created: now, updated: now, rev: 1 };
      await tx.objectStore("works").add(copy);
      await tx.objectStore("docs").add(doc, copy.id);
      for (const [i, key] of keys.entries()) {
        const value = values[i];
        if (value) await blobs.put(value, copy.id + key.slice(id.length));
      }
      return copy;
    });
  }

  /** Remove a work and everything that belongs to it, in one transaction. */
  async deleteWork(id: string): Promise<void> {
    await this.run(["works", "docs", "blobs", "rasters", "sessions"], async (tx) => {
      await tx.objectStore("works").delete(id);
      await tx.objectStore("docs").delete(id);
      await tx.objectStore("blobs").delete(prefixRange(id + "/"));
      await tx.objectStore("rasters").delete(prefixRange(id + "/"));
      await tx.objectStore("sessions").delete(id);
    });
  }

  // ---------- opening, saving, closing ----------

  /**
   * Open a work for editing. A session record marks it open; if one was already there,
   * the app was closed without going back to the gallery and the history is recovered.
   * Data that cannot be read is reported and never changed.
   */
  async loadWork(id: string, now: number): Promise<LoadedWork> {
    return this.run(["works", "docs", "blobs", "sessions"], async (tx) => {
      const meta = await tx.objectStore("works").get(id);
      const raw = await tx.objectStore("docs").get(id);
      if (!meta || raw === undefined) throw new StorageError("missing", `work ${id} not found`);
      const read = migrateDoc(raw);
      if (!read.ok) throw new StorageError(read.reason, `work ${id} cannot be opened`, read.errors);
      const keys = await tx.objectStore("blobs").getAllKeys(prefixRange(id + "/"));
      const values = await tx.objectStore("blobs").getAll(prefixRange(id + "/"));
      const images = new Map<string, Blob>();
      keys.forEach((k, i) => { const v = values[i]; if (v) images.set(k.slice(id.length + 1), v); });
      const sessions = tx.objectStore("sessions");
      const left = await sessions.get(id);
      await sessions.put({ workId: id, opened: now, lastSaved: now }, id);
      return { meta, doc: read.doc, images, recovered: !!left && hasHistory(read.doc), migrated: read.migrated };
    });
  }

  /**
   * Save a work: new pictures, the work itself and its gallery entry, all in one transaction,
   * so either everything is saved or nothing changes. Invalid data is never written.
   */
  async saveWork(id: string, input: SaveInput): Promise<WorkMeta> {
    const checked = validateDoc(input.doc);
    if (!checked.ok) throw new StorageError("invalid", "refusing to store an invalid work", checked.errors);
    return this.run(["works", "docs", "blobs", "sessions"], async (tx) => {
      const works = tx.objectStore("works");
      const meta = await works.get(id);
      if (!meta) throw new StorageError("missing", `work ${id} was deleted`);
      for (const [imageId, blob] of input.newImages ?? []) await tx.objectStore("blobs").put(blob, blobKey(id, imageId));
      await tx.objectStore("docs").put(input.doc, id);
      const next: WorkMeta = { ...meta, updated: input.now, pages: input.doc.pages.length, rev: meta.rev + 1 };
      if (input.thumb) next.thumb = input.thumb;
      await works.put(next);
      const session = await tx.objectStore("sessions").get(id);
      if (session) await tx.objectStore("sessions").put({ ...session, lastSaved: input.now }, id);
      return next;
    });
  }

  /**
   * Close a work on purpose (back to the gallery, or opening another work): the undo history
   * is folded into the work, the session ends, and pictures nothing uses any more are removed.
   */
  async closeWork(id: string, doc: WorkDoc, now: number): Promise<WorkDoc> {
    const folded = withoutHistory(doc);
    const checked = validateDoc(folded);
    if (!checked.ok) throw new StorageError("invalid", "refusing to store an invalid work", checked.errors);
    const used = imagesInUse(folded);
    await this.run(["works", "docs", "blobs", "sessions"], async (tx) => {
      const meta = await tx.objectStore("works").get(id);
      if (!meta) throw new StorageError("missing", `work ${id} was deleted`);
      await tx.objectStore("docs").put(folded, id);
      await tx.objectStore("works").put({ ...meta, updated: now, pages: folded.pages.length, rev: meta.rev + 1 });
      await tx.objectStore("sessions").delete(id);
      const blobs = tx.objectStore("blobs");
      for (const key of await blobs.getAllKeys(prefixRange(id + "/"))) if (!used.has(key.slice(id.length + 1))) await blobs.delete(key);
    });
    return folded;
  }

  /**
   * Run once when the app starts, after nothing is open yet:
   * sessions of deleted works are dropped; sessions older than the recovery window have their
   * history folded away. Works that cannot be read are left exactly as they are.
   */
  async cleanupOnStart(now: number, maxAge = RECOVERY_MAX_AGE_MS): Promise<{ orphans: number; expired: number }> {
    let orphans = 0, expired = 0;
    const sessions = await this.db.getAll("sessions");
    for (const s of sessions) {
      const meta = await this.db.get("works", s.workId);
      if (!meta) { await this.db.delete("sessions", s.workId); orphans++; continue; }
      if (now - s.lastSaved <= maxAge) continue;
      const read = migrateDoc(await this.db.get("docs", s.workId));
      if (read.ok) await this.closeWork(s.workId, read.doc, meta.updated);
      else await this.db.delete("sessions", s.workId);
      expired++;
    }
    return { orphans, expired };
  }

  // ---------- cached layer pictures ----------

  async putRaster(workId: string, pageId: string, layerId: string, rev: number, blob: Blob): Promise<void> {
    await this.db.put("rasters", { rev, blob }, `${workId}/${pageId}/${layerId}`);
  }

  /** Cached layer pictures of a page that still match the work's current save. */
  async getRasters(workId: string, pageId: string, rev: number): Promise<Map<string, Blob>> {
    const prefix = `${workId}/${pageId}/`;
    const keys = await this.db.getAllKeys("rasters", prefixRange(prefix));
    const values = await this.db.getAll("rasters", prefixRange(prefix));
    const out = new Map<string, Blob>();
    keys.forEach((k, i) => { const v = values[i]; if (v && v.rev === rev) out.set(k.slice(prefix.length), v.blob); });
    return out;
  }

  async clearRasters(workId: string): Promise<void> {
    await this.db.delete("rasters", prefixRange(workId + "/"));
  }

  // ---------- imported fonts ----------

  async listFonts(): Promise<FontRecord[]> {
    return this.db.getAll("fonts");
  }

  /** Add a font. An existing font with the same name is kept, never replaced. */
  async putFont(name: string, data: Blob, now: number): Promise<boolean> {
    return this.run(["fonts"], async (tx) => {
      if (await tx.objectStore("fonts").get(name)) return false;
      await tx.objectStore("fonts").add({ name, data, added: now }, name);
      return true;
    });
  }

  async deleteFont(name: string): Promise<void> {
    await this.db.delete("fonts", name);
  }

  // ---------- helpers ----------

  /** One read-write transaction over `stores`; resolves only after it has committed. */
  async run<T>(stores: StoreName[], body: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      const tx = this.db.transaction(stores, "readwrite");
      let result: T;
      try {
        result = await body(tx);
      } catch (err) {
        try { tx.abort(); } catch { /* already finished */ }
        await tx.done.catch(() => undefined);
        throw err;
      }
      await tx.done;
      return result;
    } catch (err) {
      throw asStorageError(err);
    }
  }
}
