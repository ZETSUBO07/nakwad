import { t } from "../i18n";
import { openDialog } from "./dialog";
import { button, h } from "./dom";
import { toast } from "./toast";

/** Save a file to the device (the browser's download). */
export function saveFile(blob: Blob, file: string): void {
  const url = URL.createObjectURL(blob);
  const a = h("a", { attrs: { href: url, download: file } });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Whether this browser can send this file with the system share menu (Android's share sheet). */
export function canShareFile(blob: Blob, file: string): boolean {
  try {
    return typeof navigator.canShare === "function" && navigator.canShare({ files: [new File([blob], file, { type: blob.type })] });
  } catch {
    return false;
  }
}

/**
 * Send a file with the share menu. Must run straight from a tap (the browser asks for one).
 * Resolves to true when it was shared, false when the person closed the menu or sharing failed.
 */
export async function shareFile(blob: Blob, file: string): Promise<boolean> {
  try {
    await navigator.share({ files: [new File([blob], file, { type: blob.type })] });
    toast(t("fileShared", { file }));
    return true;
  } catch (err) {
    // closing the menu is not an error worth a message
    if ((err as DOMException)?.name !== "AbortError") { console.error(err); toast(t("fileShareFailed")); }
    return false;
  }
}

/**
 * A file that took a while to make (a backup): ask where it goes, save to the device or share.
 * The second tap is needed anyway: sharing has to start from a tap, and making the file takes longer
 * than the browser waits after the first one. Resolves to how it left, or null when closed.
 */
export function deliverFile(blob: Blob, file: string): Promise<"saved" | "shared" | null> {
  return new Promise((resolve) => {
    let how: "saved" | "shared" | null = null;
    const save = button({ icon: "download", label: t("fileSave"), class: "primary", data: { action: "file-save" } });
    const share = button({ label: t("fileShare"), data: { action: "file-share" } });
    share.hidden = !canShareFile(blob, file);
    const info = h("span", { class: "muted", text: blob.size < 1048576
      ? t("fileReadyInfoKb", { file, kb: Math.max(1, Math.round(blob.size / 1024)) })
      : t("fileReadyInfo", { file, mb: (blob.size / 1048576).toFixed(1) }) });
    const dlg = openDialog(t("fileReadyTitle"), [h("div", { class: "sheet-foot" }, info, share, save)], () => resolve(how), { id: "file-ready", closeLabel: t("close") });
    save.addEventListener("click", () => {
      saveFile(blob, file);
      toast(t("exportSaved", { file }));
      how = "saved";
      dlg.close();
    });
    share.addEventListener("click", async () => {
      share.disabled = true;
      if (await shareFile(blob, file)) { how = "shared"; dlg.close(); }
      share.disabled = false;
    });
  });
}
