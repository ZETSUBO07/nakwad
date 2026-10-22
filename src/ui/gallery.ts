import type { Store, WorkMeta } from "../storage";
import { isLowOnSpace, storageInfo } from "../storage";
import { t } from "../i18n";
import { openDialog } from "./dialog";
import { button, formatDate, h } from "./dom";
import { toast } from "./toast";
import type { Prefs } from "./prefs";

export interface GalleryActions {
  open(id: string): void;
  create(): void;
}

/** The list of works: open, new, rename, duplicate, delete (with a second press to confirm). */
export class Gallery {
  readonly el: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly info: HTMLElement;
  private readonly empty: HTMLElement;
  private urls: string[] = [];
  private armTimer = 0;

  constructor(private readonly store: Store | null, private readonly prefs: Prefs, private readonly actions: GalleryActions) {
    this.info = h("p", { class: "ginfo", data: { testid: "storage" } });
    const version = h("p", { class: "version", text: t("versionLabel", { version: __APP_VERSION__ }), data: { testid: "version" } });
    const lab = h("a", { class: "ghost-link", text: t("openLab"), attrs: { href: `${import.meta.env.BASE_URL}lab.html` } });
    const head = h("header", { class: "ghead" },
      h("img", { class: "gicon", attrs: { src: `${import.meta.env.BASE_URL}icons/icon-192.png`, alt: "", width: "56", height: "56" } }),
      h("div", { class: "gtitle" }, h("h1", { text: t("appName") }), this.info),
      h("div", { class: "gside" }, lab, version));
    this.grid = h("div", { class: "ggrid" });
    this.empty = h("p", { class: "gempty" });
    this.el = h("main", { class: "gallery", attrs: { "aria-label": t("gallery") } }, head, this.grid, this.empty);
  }

  async show(): Promise<void> {
    let list: WorkMeta[] = [];
    let failed = false;
    if (this.store) {
      try { list = await this.store.listWorks(); } catch (err) { console.error(err); failed = true; }
    }
    for (const u of this.urls) URL.revokeObjectURL(u);
    this.urls = [];
    this.grid.replaceChildren(this.newCard(), ...list.map((w) => this.card(w)));
    this.empty.hidden = list.length > 0 && !failed;
    this.empty.textContent = !this.store ? t("galleryNoStorage") : failed ? t("galleryLoadFailed") : t("galleryEmpty");
    void this.storageLine();
  }

  private async storageLine(): Promise<void> {
    if (!this.store) { this.info.textContent = t("galleryNoStorage"); return; }
    const s = await storageInfo();
    const parts = [t("galleryStorage")];
    if (s.usedBytes !== null) parts.push(t("galleryUsed", { mb: (s.usedBytes / 1048576).toFixed(1) }));
    if (s.persisted) parts.push(t("galleryPersisted"));
    this.info.textContent = parts.join(" · ");
    if (isLowOnSpace(s)) toast(t("galleryLowSpace"), 6000);
  }

  private newCard(): HTMLElement {
    const last = this.prefs.lastPaper;
    const thumb = button({ icon: "plus", label: t("workNew"), class: "gthumb", data: { action: "new-work" }, onClick: () => this.actions.create() });
    return h("article", { class: "gcard gnew" }, thumb,
      h("div", { class: "gmeta" }, h("div", { class: "gtext" }, h("b", { text: t("workNewHint") }),
        h("small", { text: last ? t("workNewHintLast", { w: last.w, h: last.h }) : t("workNewHintNone") }))));
  }

  private card(w: WorkMeta): HTMLElement {
    const thumb = h("button", { class: "gthumb", attrs: { type: "button", "aria-label": t("workOpen", { name: w.name }) }, data: { action: "open" } });
    if (w.thumb) {
      const url = URL.createObjectURL(w.thumb);
      this.urls.push(url);
      thumb.append(h("img", { attrs: { src: url, alt: "" } }));
    }
    thumb.addEventListener("click", () => this.actions.open(w.id));
    const del = button({ icon: "trash", title: t("workDelete"), class: "icon-btn", data: { action: "delete" } });
    del.addEventListener("click", () => void this.remove(w, del));
    return h("article", { class: "gcard", data: { work: w.id } }, thumb,
      h("div", { class: "gmeta" },
        h("div", { class: "gtext" }, h("b", { text: w.name }), h("small", { text: t("workCardInfo", { date: formatDate(w.updated), pages: w.pages }) })),
        button({ icon: "rename", title: t("workRename"), class: "icon-btn", data: { action: "rename" }, onClick: () => this.rename(w) }),
        button({ icon: "copy", title: t("workDuplicate"), class: "icon-btn", data: { action: "duplicate" }, onClick: () => void this.duplicate(w) }),
        del));
  }

  private rename(w: WorkMeta): void {
    if (!this.store) return;
    const store = this.store;
    const input = h("input", { class: "text-input", attrs: { type: "text", maxlength: "60", "aria-label": t("workName") } });
    input.value = w.name;
    const ok = button({ label: t("save"), class: "primary", data: { action: "rename-ok" } });
    const dlg = openDialog(t("workRenameTitle"), [input, h("div", { class: "sheet-foot" }, h("span"), ok)], () => undefined);
    const submit = async () => {
      const name = input.value.trim();
      dlg.close();
      if (!name || name === w.name) return;
      try { await store.renameWork(w.id, name); } catch (err) { console.error(err); toast(t("actionFailed")); }
      await this.show();
    };
    ok.addEventListener("click", () => void submit());
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); void submit(); } });
    input.select();
  }

  private async duplicate(w: WorkMeta): Promise<void> {
    if (!this.store) return;
    try { await this.store.duplicateWork(w.id, t("workCopyName", { name: w.name }), Date.now()); toast(t("workDuplicated")); }
    catch (err) { console.error(err); toast(t("actionFailed")); }
    await this.show();
  }

  private async remove(w: WorkMeta, del: HTMLButtonElement): Promise<void> {
    if (!this.store) return;
    if (!del.classList.contains("armed")) {
      // a second press within 3 seconds deletes
      for (const b of this.grid.querySelectorAll(".armed")) b.classList.remove("armed");
      del.classList.add("armed");
      toast(t("workDeleteArmed", { name: w.name }));
      clearTimeout(this.armTimer);
      this.armTimer = window.setTimeout(() => del.classList.remove("armed"), 3000);
      return;
    }
    try { await this.store.deleteWork(w.id); toast(t("workDeleted", { name: w.name })); }
    catch (err) { console.error(err); toast(t("actionFailed")); }
    await this.show();
  }
}
