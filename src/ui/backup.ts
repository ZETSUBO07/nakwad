import { t } from "../i18n";
import { BACKUP_LIMITS, backupFileName, exportBackup, importBackup, type Store, type WorkMeta } from "../storage";
import { openDialog } from "./dialog";
import { button, h } from "./dom";
import { cleanFileName } from "./exporter";
import { deliverFile } from "./files";
import type { Prefs } from "./prefs";
import { toast } from "./toast";

/** spec: remind when nothing was backed up for this long and there is work that is not in a backup */
export const BACKUP_REMIND_DAYS = 14;
const DAY = 86_400_000;

/**
 * Whether to remind about a backup: some work changed since the last backup (or there never was
 * one), and the last backup (or, without one, the oldest work) is older than `days`.
 */
export function backupDue(works: readonly Pick<WorkMeta, "created" | "updated">[], last: number | null, now: number, days = BACKUP_REMIND_DAYS): boolean {
  if (!works.length) return false;
  const since = last ?? Math.min(...works.map((w) => w.created));
  if (now - since < days * DAY) return false;
  return last === null || works.some((w) => w.updated > last);
}

export interface BackupEnv {
  store: Store;
  prefs: Prefs;
  savePrefs(): void;
}

/**
 * Back up every work (or the named ones) to a .sketchbook file, then save or share it.
 * Only a backup of everything counts as "last backup".
 */
export async function runBackup(env: BackupEnv, workIds?: string[]): Promise<boolean> {
  const now = Date.now();
  const all = !workIds;
  const works = await env.store.listWorks();
  if (!works.length) { toast(t("backupNothing")); return false; }
  toast(t("backupMaking"));
  const bytes = await exportBackup(env.store, { appVersion: __APP_VERSION__, now, ...(workIds ? { workIds } : {}) });
  const one = workIds?.length === 1 ? works.find((w) => w.id === workIds[0]) : undefined;
  const file = one ? `${cleanFileName(one.name, "sketch")}.sketchbook` : backupFileName(now);
  const how = await deliverFile(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" }), file);
  if (!how) return false;
  if (all) { env.prefs.lastBackup = now; env.savePrefs(); }
  return true;
}

/** Add the works in a backup file; never touches what is already there. Resolves to how many were added. */
export async function runRestore(store: Store, file: Blob): Promise<number> {
  if (file.size > BACKUP_LIMITS.fileBytes) { toast(t("restoreTooBig"), 6000); return 0; }
  toast(t("restoreWorking"));
  try {
    const r = await importBackup(store, new Uint8Array(await file.arrayBuffer()), Date.now());
    if (!r.works.length && !r.skipped.length) { toast(t("restoreNone"), 6000); return 0; }
    const parts = [t("restoreDone", { n: r.works.length })];
    if (r.skipped.length) parts.push(t("restoreSkipped", { n: r.skipped.length }));
    toast(parts.join(" · "), 6000);
    return r.works.length;
  } catch (err) {
    console.error(err);
    toast(t("restoreBadFile"), 6000);
    return 0;
  }
}

/** Ask before adding the works of a file that arrived from outside (the Android share menu). */
export function askRestore(fileName: string): Promise<boolean> {
  return new Promise((resolve) => {
    let ok = false;
    const go = button({ label: t("restoreOk"), class: "primary", data: { action: "restore-ok" } });
    const dlg = openDialog(t("restoreAskTitle"), [h("p", { text: t("restoreAsk", { file: fileName }) }), h("div", { class: "sheet-foot" }, h("span"), go)],
      () => resolve(ok), { id: "restore-ask" });
    go.addEventListener("click", () => { ok = true; dlg.close(); });
  });
}

const SHARE_CACHE = "nakwad-share";
const SHARE_KEY = "__shared__";

/**
 * A file shared to the app (manifest share_target): the service worker keeps it and opens the app
 * with ?shared=1. Take it out (once) and clean the address.
 */
export async function takeSharedFile(base: string): Promise<File | null> {
  const url = new URL(location.href);
  if (url.searchParams.get("shared") !== "1") return null;
  url.searchParams.delete("shared");
  history.replaceState(null, "", url);
  if (!("caches" in self)) return null;
  const cache = await caches.open(SHARE_CACHE);
  const key = `${base}${SHARE_KEY}`;
  const res = await cache.match(key);
  if (!res) return null;
  await cache.delete(key);
  const name = decodeURIComponent(res.headers.get("x-file-name") ?? "") || "backup.sketchbook";
  return new File([await res.blob()], name);
}
