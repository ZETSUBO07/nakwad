import { strToU8, zipSync, type Zippable } from "fflate";
import { describe, expect, it } from "vitest";
import { commit } from "../../../src/core";
import { BACKUP_FORMAT, BACKUP_LIMITS, StorageError, backupFileName, cleanName, exportBackup, imageType, importBackup, isFontData } from "../../../src/storage";
import { PNG, bytes, freshStore, png, sampleDoc } from "./helpers";

const TTF = new Uint8Array([0, 1, 0, 0, 9, 9, 9]);

async function filledStore() {
  const store = await freshStore();
  const doc = sampleDoc();
  doc.pages[0] = commit(doc.pages[0]!, { type: "add", id: "L2", index: 1, text: { tid: "T1", x: 0, y: 0, text: "hi", font: "My Font", size: 40, color: "#000000", align: "left", rot: 0 } });
  doc.layers.L2 = { name: "Text", visible: true, opacity: 1 };
  const meta = await store.createWork(doc, "Cat", 1000);
  await store.saveWork(meta.id, { doc, newImages: new Map([["I1", png(5)], ["I8", png(6)]]), now: 2000 });
  await store.putFont("My Font", new Blob([TTF]), 1);
  await store.putFont("Unused Font", new Blob([TTF]), 1);
  return { store, id: meta.id, doc };
}

const expectBackupError = async (p: Promise<unknown>, text: string | RegExp) => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(StorageError);
  expect((err as StorageError).kind).toBe("backup");
  expect((err as StorageError).message).toMatch(text);
};

const manifest = (extra: object = {}) => strToU8(JSON.stringify({ format: BACKUP_FORMAT, version: 1, app: "t", created: 1, works: [], fonts: [], ...extra }));

describe("backup and restore", () => {
  it("restores every work, picture and used font on another device, with new ids", async () => {
    const { store, id, doc } = await filledStore();
    const file = await exportBackup(store, { appVersion: "0.1.0", now: 3000 });
    const other = await freshStore();
    await other.putFont("My Font", new Blob([new Uint8Array([0, 1, 0, 0, 1])]), 1);
    const r = await importBackup(other, file, 4000);
    expect(r.works).toHaveLength(1);
    expect(r.works[0]!.id).not.toBe(id);
    expect(r.works[0]!.name).toBe("Cat");
    expect(r.fontsKept).toEqual(["My Font"]);
    expect(r.fontsAdded).toEqual([]);
    expect((await other.listFonts()).map((f) => f.name)).toEqual(["My Font"]);
    const loaded = await other.loadWork(r.works[0]!.id, 5000);
    expect(loaded.doc).toEqual(doc);
    expect(await bytes(loaded.images.get("I1"))).toEqual(await bytes(png(5)));
    expect(loaded.images.has("I8")).toBe(false);
    expect((await other.listWorks())[0]!.created).toBe(1000);
  });

  it("brings fonts that are missing, and importing twice adds a second copy instead of overwriting", async () => {
    const { store } = await filledStore();
    const file = await exportBackup(store, { appVersion: "0.1.0", now: 3000 });
    const other = await freshStore();
    expect((await importBackup(other, file, 4000)).fontsAdded).toEqual(["My Font"]);
    await importBackup(other, file, 5000);
    expect(await other.listWorks()).toHaveLength(2);
  });

  it("can back up chosen works only", async () => {
    const { store } = await filledStore();
    await store.createWork(sampleDoc(), "Dog", 1500);
    const file = await exportBackup(store, { appVersion: "x", now: 3000, workIds: [] });
    const r = await importBackup(await freshStore(), file, 4000);
    expect(r.works).toEqual([]);
  });

  it("leaves out works that cannot be read instead of copying them broken", async () => {
    const { store, id } = await filledStore();
    await store.db.put("docs", { schema: 1, broken: true }, id);
    const r = await importBackup(await freshStore(), await exportBackup(store, { appVersion: "x", now: 1 }), 2);
    expect(r.works).toEqual([]);
  });
});

describe("refusing bad backup files", () => {
  it("not a zip, not ours, from a newer app, or a damaged list", async () => {
    const store = await freshStore();
    await expectBackupError(importBackup(store, new Uint8Array([1, 2, 3]), 1), /zip/);
    await expectBackupError(importBackup(store, zipSync({ "manifest.json": strToU8("{}") }), 1), /not a backup/);
    await expectBackupError(importBackup(store, zipSync({ "manifest.json": strToU8("nope") }), 1), /not a backup/);
    await expectBackupError(importBackup(store, zipSync({ "manifest.json": manifest({ version: 99 }) }), 1), /newer/);
    await expectBackupError(importBackup(store, zipSync({ "manifest.json": manifest({ works: "x" }) }), 1), /damaged/);
  });

  it("files with unexpected names, such as path tricks", async () => {
    const store = await freshStore();
    await expectBackupError(importBackup(store, zipSync({ "manifest.json": manifest(), "../evil.js": strToU8("x") }), 1), /unexpected/);
    await expectBackupError(importBackup(store, zipSync({ "manifest.json": manifest(), "works/a/../../x": strToU8("x") }), 1), /unexpected/);
  });

  it("too many files", async () => {
    const files: Zippable = { "manifest.json": manifest() };
    for (let i = 0; i <= BACKUP_LIMITS.entries; i++) files[`fonts/${i % 99999}${i >= 99999 ? "" : ""}`] = new Uint8Array(0);
    const big: Zippable = { "manifest.json": manifest() };
    for (let i = 0; i <= BACKUP_LIMITS.entries; i++) big[`works/w${i}/meta.json`] = new Uint8Array(0);
    await expectBackupError(importBackup(await freshStore(), zipSync(big, { level: 0 }), 1), /too many/);
  });

  it("skips works that are damaged, missing pictures, or carry something that is not a picture", async () => {
    const { store } = await filledStore();
    const good = await exportBackup(store, { appVersion: "x", now: 1 });
    const { unzipSync } = await import("fflate");
    const files = unzipSync(good) as Zippable;
    const [docName] = Object.keys(files).filter((k) => k.endsWith("doc.json"));
    const id = docName!.split("/")[1]!;
    const variants: [string, (f: Zippable) => void][] = [
      ["damaged work", (f) => { f[docName!] = strToU8("{bad json"); }],
      ["missing picture", (f) => { Reflect.deleteProperty(f, `works/${id}/images/I1`); }],
      ["not a picture", (f) => { f[`works/${id}/images/I1`] = strToU8("<script>"); }],
      ["newer work", (f) => { f[docName!] = strToU8(JSON.stringify({ schema: 99 })); }],
      ["bad id", (f) => { f["manifest.json"] = manifest({ works: [{ id: "../x", name: "n" }] }); }],
    ];
    for (const [label, edit] of variants) {
      const f = { ...files };
      edit(f);
      const r = await importBackup(await freshStore(), zipSync(f), 1);
      expect(r.works, label).toEqual([]);
      expect(r.skipped.length, label).toBe(1);
    }
  });
});

describe("helpers", () => {
  it("recognises pictures and fonts by their bytes", () => {
    expect(imageType(PNG)).toBe("image/png");
    expect(imageType(new Uint8Array([0xff, 0xd8, 0xff, 0]))).toBe("image/jpeg");
    expect(imageType(new Uint8Array([...strToU8("RIFF"), 0, 0, 0, 0, ...strToU8("WEBP")]))).toBe("image/webp");
    expect(imageType(strToU8("<svg"))).toBeNull();
    for (const sig of ["OTTO", "true", "wOFF", "wOF2"]) expect(isFontData(strToU8(sig + "xx"))).toBe(true);
    expect(isFontData(TTF)).toBe(true);
    expect(isFontData(strToU8("hello"))).toBe(false);
  });

  it("cleans names and makes dated file names", () => {
    expect(cleanName("  Cat\u0000‮  ", "?")).toBe("Cat");
    expect(cleanName(5, "?")).toBe("?");
    expect(cleanName("   ", "?")).toBe("?");
    expect(cleanName("x".repeat(500), "?")).toHaveLength(BACKUP_LIMITS.nameLength);
    expect(backupFileName(Date.UTC(2026, 9, 22))).toBe("nakwad-2026-10-22.sketchbook");
  });
});
