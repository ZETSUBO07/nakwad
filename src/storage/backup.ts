import { strFromU8, strToU8, unzipSync, zipSync, type Unzipped, type Zippable } from "fflate";
import { fontsInUse, imagesInUse, type WorkDoc } from "../core";
import { StorageError } from "./errors";
import { migrateDoc } from "./migrate";
import { prefixRange } from "./schema";
import { newWorkId, type Store } from "./store";

/**
 * .sketchbook backup files: one zip holding works, their pictures and the imported fonts they use.
 *
 *   manifest.json                      { format, version, app, created, works: [...], fonts: [...] }
 *   works/<id>/doc.json                the work
 *   works/<id>/meta.json               name and dates
 *   works/<id>/images/<imageId>        picture bytes (PNG, JPEG or WebP)
 *   fonts/<n>                          font bytes (TTF, OTF, WOFF, WOFF2)
 *
 * Import never trusts the file: sizes, names, counts, file types and every work are checked,
 * and imported works always get new ids so nothing already on the device is overwritten.
 */
export const BACKUP_FORMAT = "nakwad-sketchbook";
export const BACKUP_VERSION = 1;

export const BACKUP_LIMITS = {
  fileBytes: 500e6,
  totalUnzippedBytes: 800e6,
  entryBytes: 200e6,
  entries: 20_000,
  works: 500,
  nameLength: 200,
} as const;

interface ManifestWork { id: string; name: string; created: number; updated: number }
interface ManifestFont { name: string; file: string }
interface Manifest { format: string; version: number; app: string; created: number; works: ManifestWork[]; fonts: ManifestFont[] }

export interface ImportResult {
  works: { id: string; name: string }[];
  fontsAdded: string[];
  /** fonts already on the device under the same name: kept as they were */
  fontsKept: string[];
  /** works in the file that could not be imported, with the reason */
  skipped: { name: string; reason: string }[];
}

const ENTRY = /^(manifest\.json|works\/[A-Za-z0-9_-]{1,64}\/(doc\.json|meta\.json|images\/[A-Za-z0-9_-]{1,64})|fonts\/[0-9]{1,5})$/;

const bytesOf = async (b: Blob) => new Uint8Array(await b.arrayBuffer());
const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** PNG, JPEG or WebP, by the bytes rather than the file name. */
export function imageType(b: Uint8Array): string | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(b, ascii("RIFF")) && startsWith(b, ascii("WEBP"), 8)) return "image/webp";
  return null;
}

/** TrueType, OpenType, WOFF or WOFF2, by the bytes. */
export function isFontData(b: Uint8Array): boolean {
  return startsWith(b, [0, 1, 0, 0]) || startsWith(b, ascii("OTTO")) || startsWith(b, ascii("true")) || startsWith(b, ascii("wOFF")) || startsWith(b, ascii("wOF2"));
}

/** A safe display name: no control characters, trimmed, length-limited. */
export function cleanName(v: unknown, fallback: string): string {
  if (typeof v !== "string") return fallback;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, "").trim().slice(0, BACKUP_LIMITS.nameLength);
  return s || fallback;
}

/** Build a backup of the given works (all works when none are named). */
export async function exportBackup(store: Store, opts: { appVersion: string; now: number; workIds?: string[] }): Promise<Uint8Array> {
  const metas = (await store.listWorks()).filter((m) => !opts.workIds || opts.workIds.includes(m.id));
  const files: Zippable = {};
  const manifest: Manifest = { format: BACKUP_FORMAT, version: BACKUP_VERSION, app: opts.appVersion, created: opts.now, works: [], fonts: [] };
  const usedFonts = new Set<string>();
  for (const meta of metas) {
    const raw = await store.db.get("docs", meta.id);
    const read = migrateDoc(raw);
    if (!read.ok) continue; // a work that cannot be read is left out rather than copied broken
    const doc = read.doc;
    for (const f of fontsInUse(doc)) usedFonts.add(f);
    const base = `works/${meta.id}/`;
    files[base + "doc.json"] = strToU8(JSON.stringify(doc));
    files[base + "meta.json"] = strToU8(JSON.stringify({ name: meta.name, created: meta.created, updated: meta.updated }));
    const keys = await store.db.getAllKeys("blobs", prefixRange(meta.id + "/"));
    const used = imagesInUse(doc);
    for (const key of keys) {
      const imageId = key.slice(meta.id.length + 1);
      if (!used.has(imageId)) continue;
      const blob = await store.db.get("blobs", key);
      // pictures are already compressed: store them without compressing again
      if (blob) files[base + "images/" + imageId] = [await bytesOf(blob), { level: 0 }];
    }
    manifest.works.push({ id: meta.id, name: meta.name, created: meta.created, updated: meta.updated });
  }
  let n = 0;
  for (const font of await store.listFonts()) {
    if (!usedFonts.has(font.name)) continue;
    const file = `fonts/${n++}`;
    files[file] = [await bytesOf(font.data), { level: 6 }];
    manifest.fonts.push({ name: font.name, file });
  }
  files["manifest.json"] = strToU8(JSON.stringify(manifest));
  return zipSync(files, { level: 6 });
}

function readZip(bytes: Uint8Array): Unzipped {
  if (bytes.byteLength > BACKUP_LIMITS.fileBytes) throw new StorageError("backup", "backup file too large");
  let count = 0, total = 0;
  let problem: string | null = null;
  let unzipped: Unzipped;
  try {
    unzipped = unzipSync(bytes, {
      filter: (f) => {
        if (f.name.endsWith("/")) return false;
        count++;
        total += f.originalSize;
        if (!ENTRY.test(f.name)) problem ??= `unexpected file in backup: ${f.name.slice(0, 80)}`;
        else if (f.originalSize > BACKUP_LIMITS.entryBytes) problem ??= `file too large in backup: ${f.name}`;
        else if (count > BACKUP_LIMITS.entries) problem ??= "too many files in backup";
        else if (total > BACKUP_LIMITS.totalUnzippedBytes) problem ??= "backup unpacks too large";
        return problem === null;
      },
    });
  } catch (err) {
    throw new StorageError("backup", "not a readable zip file", [String(err)]);
  }
  if (problem) throw new StorageError("backup", problem);
  // a file can lie about its size: check what actually came out
  for (const [name, data] of Object.entries(unzipped)) if (data.byteLength > BACKUP_LIMITS.entryBytes) throw new StorageError("backup", `file too large in backup: ${name}`);
  return unzipped;
}

function readJson(files: Unzipped, name: string): unknown {
  const data = files[name];
  if (!data) return undefined;
  try { return JSON.parse(strFromU8(data)); } catch { return undefined; }
}

function readManifest(files: Unzipped): Manifest {
  const m = readJson(files, "manifest.json") as Partial<Manifest> | undefined;
  if (!m || m.format !== BACKUP_FORMAT) throw new StorageError("backup", "not a backup from this app");
  if (typeof m.version !== "number" || m.version > BACKUP_VERSION) throw new StorageError("backup", "backup made by a newer app");
  if (!Array.isArray(m.works) || m.works.length > BACKUP_LIMITS.works || !Array.isArray(m.fonts)) throw new StorageError("backup", "damaged backup list");
  return m as Manifest;
}

/** Add the works (and fonts) in a backup to this device. Existing works and fonts are never touched. */
export async function importBackup(store: Store, bytes: Uint8Array, now: number): Promise<ImportResult> {
  const files = readZip(bytes);
  const manifest = readManifest(files);
  const result: ImportResult = { works: [], fontsAdded: [], fontsKept: [], skipped: [] };

  for (const f of manifest.fonts) {
    const name = cleanName(f?.name, "");
    const data = typeof f?.file === "string" ? files[f.file] : undefined;
    if (!name || !data || !isFontData(data)) continue;
    if (await store.putFont(name, new Blob([data as Uint8Array<ArrayBuffer>]), now)) result.fontsAdded.push(name);
    else result.fontsKept.push(name);
  }

  for (const w of manifest.works) {
    const fallback = "?";
    const id = typeof w?.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(w.id) ? w.id : null;
    const meta = id ? readJson(files, `works/${id}/meta.json`) as Record<string, unknown> | undefined : undefined;
    const name = cleanName(meta?.name ?? w?.name, fallback);
    if (!id) { result.skipped.push({ name, reason: "bad id" }); continue; }
    const read = migrateDoc(readJson(files, `works/${id}/doc.json`));
    if (!read.ok) { result.skipped.push({ name, reason: read.reason === "newer" ? "made by a newer app" : "damaged work" }); continue; }
    const doc: WorkDoc = read.doc;
    const images = new Map<string, Blob>();
    let missing: string | null = null;
    for (const imageId of imagesInUse(doc)) {
      const data = files[`works/${id}/images/${imageId}`];
      const type = data ? imageType(data) : null;
      if (!data || !type) { missing = imageId; break; }
      images.set(imageId, new Blob([data as Uint8Array<ArrayBuffer>], { type }));
    }
    if (missing) { result.skipped.push({ name, reason: `picture ${missing} missing or not a picture` }); continue; }
    const created = typeof meta?.created === "number" && Number.isFinite(meta.created) ? meta.created : now;
    const newId = newWorkId(now);
    await store.run(["works", "docs", "blobs"], async (tx) => {
      await tx.objectStore("works").add({ id: newId, name, created, updated: now, pages: doc.pages.length, rev: 1 });
      await tx.objectStore("docs").add(doc, newId);
      for (const [imageId, blob] of images) await tx.objectStore("blobs").add(blob, `${newId}/${imageId}`);
    });
    result.works.push({ id: newId, name });
  }
  return result;
}

/** A backup file name such as "nakwad-2026-10-22.sketchbook". */
export function backupFileName(now: number): string {
  return `nakwad-${new Date(now).toISOString().slice(0, 10)}.sketchbook`;
}
