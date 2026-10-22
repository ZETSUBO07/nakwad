import type { DBSchema, IDBPDatabase } from "idb";

export const DB_NAME = "nakwad";
/** IndexedDB version. Raise it and add a step in `upgrade` when stores or indexes change. */
export const DB_VERSION = 1;

/** What the gallery shows for a work. The work itself is in `docs`. */
export interface WorkMeta {
  id: string;
  name: string;
  created: number;
  updated: number;
  pages: number;
  /** goes up on every save; cached layer pictures from an older rev are ignored */
  rev: number;
  thumb?: Blob;
}

/** A work that is open (or was open when the app was closed without going back to the gallery). */
export interface SessionRecord {
  workId: string;
  opened: number;
  lastSaved: number;
}

/** A layer drawn to pixels, kept only to open works faster. Losing it loses nothing. */
export interface RasterRecord {
  rev: number;
  blob: Blob;
}

export interface FontRecord {
  name: string;
  data: Blob;
  added: number;
}

export interface NakwadDB extends DBSchema {
  works: { key: string; value: WorkMeta; indexes: { updated: number } };
  /** the work itself (a WorkDoc), stored raw and always validated when read */
  docs: { key: string; value: unknown };
  /** pictures, keyed "<workId>/<imageId>" */
  blobs: { key: string; value: Blob };
  /** cached layer pictures, keyed "<workId>/<pageId>/<layerId>" */
  rasters: { key: string; value: RasterRecord };
  /** fonts the user imported, keyed by font name */
  fonts: { key: string; value: FontRecord };
  /** open works, keyed by work id: used to recover undo history after a crash */
  sessions: { key: string; value: SessionRecord };
}

export type DB = IDBPDatabase<NakwadDB>;

export function upgrade(db: IDBPDatabase<NakwadDB>, oldVersion: number): void {
  if (oldVersion < 1) {
    db.createObjectStore("works", { keyPath: "id" }).createIndex("updated", "updated");
    db.createObjectStore("docs");
    db.createObjectStore("blobs");
    db.createObjectStore("rasters");
    db.createObjectStore("fonts");
    db.createObjectStore("sessions");
  }
}

/** Every key that starts with `prefix` (keys are plain strings, so a range does it). */
export const prefixRange = (prefix: string): IDBKeyRange => IDBKeyRange.bound(prefix, prefix + "￿");
