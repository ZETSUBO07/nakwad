import { derive, type Page, type WorkDoc } from "../core";
import { t } from "../i18n";
import { PageRenderer } from "../render";
import { button, h } from "./dom";
import { toast } from "./toast";

export interface PagesHost {
  doc(): WorkDoc;
  /** small picture of the open page (kept up to date by the editor) */
  currentThumb(max: number): OffscreenCanvas;
  image(id: string): CanvasImageSource | undefined;
  open(index: number): void;
  add(): void;
  duplicate(): void;
  remove(): void;
}

const THUMB = 40;
/** Pictures of pages that are not open, made once per version of the page. */
const cache = new WeakMap<Page, OffscreenCanvas>();

function thumbOf(p: Page, doc: WorkDoc, image: PagesHost["image"]): OffscreenCanvas {
  let c = cache.get(p);
  if (!c) {
    const s = derive(p), r = new PageRenderer({ image });
    r.setState(s, doc.layers, Math.min(1, (THUMB * 2) / Math.max(s.w, s.h)));
    c = r.thumbnail(doc.paper, THUMB * 2);
    cache.set(p, c);
  }
  return c;
}

/** The pages of a work as small chips in the top bar, with add, duplicate and delete. */
export class PageStrip {
  readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private readonly delBtn: HTMLButtonElement;
  private armTimer = 0;

  constructor(private readonly host: PagesHost) {
    this.list = h("div", { class: "pchips", attrs: { role: "tablist", "aria-label": t("pages") } });
    const add = button({ icon: "plus", title: t("pageAdd"), class: "icon-btn", data: { action: "page-add" }, onClick: () => host.add() });
    const dup = button({ icon: "copy", title: t("pageDuplicate"), class: "icon-btn", data: { action: "page-duplicate" }, onClick: () => host.duplicate() });
    this.delBtn = button({ icon: "trash", title: t("pageDelete"), class: "icon-btn", data: { action: "page-delete" } });
    this.delBtn.addEventListener("click", () => this.remove());
    this.el = h("div", { class: "pagestrip", data: { testid: "pages" } }, this.list, add, dup, this.delBtn);
  }

  update(): void {
    const doc = this.host.doc();
    this.list.replaceChildren(...doc.pages.map((p, i) => {
      const s = derive(p), k = THUMB / Math.max(s.w, s.h);
      const c = h("canvas", { attrs: { width: String(Math.round(s.w * k * 2)), height: String(Math.round(s.h * k * 2)) } });
      c.style.width = `${Math.round(s.w * k)}px`;
      c.style.height = `${Math.round(s.h * k)}px`;
      const src = i === doc.current ? this.host.currentThumb(THUMB * 2) : thumbOf(p, doc, this.host.image);
      c.getContext("2d")?.drawImage(src, 0, 0, c.width, c.height);
      const b = h("button", { class: "pchip", attrs: { type: "button", role: "tab", "aria-selected": String(i === doc.current), "aria-label": t("pageN", { n: i + 1 }) }, data: { page: String(i) } },
        c, h("span", { text: String(i + 1) }));
      b.addEventListener("click", () => { if (i !== this.host.doc().current) this.host.open(i); });
      return b;
    }));
    this.delBtn.disabled = doc.pages.length < 2;
    this.delBtn.classList.remove("armed");
    (this.list.querySelector('[aria-selected="true"]') as HTMLElement | null)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  /** Deleting a page cannot be undone, so it takes a second press within 3 seconds. */
  private remove(): void {
    const n = this.host.doc().current + 1;
    if (!this.delBtn.classList.contains("armed")) {
      this.delBtn.classList.add("armed");
      toast(t("pageDeleteArmed", { n }));
      clearTimeout(this.armTimer);
      this.armTimer = window.setTimeout(() => this.delBtn.classList.remove("armed"), 3000);
      return;
    }
    this.delBtn.classList.remove("armed");
    this.host.remove();
    toast(t("pageDeleted", { n }));
  }
}
