import { canRedo, canUndo, commit, derive, redo, undo, type Page, type Point, type StrokeEntry, type WorkDoc } from "../core";
import { t } from "../i18n";
import { IDENTITY, Stabilizer, attachInput, zoomPercent, type Frame, type InputController, type View } from "../input";
import { PageRenderer, fitScale, onCanvasRestored, targetDpr } from "../render";
import { AutoSaver, StorageError, acquireWorkLock, requestPersistence, type SaveStatus, type Store, type WorkMeta } from "../storage";
import { button, h } from "./dom";
import { toast } from "./toast";

/** Until the toolbar arrives (M6.2) the editor draws with one pen. */
const PEN = { brush: "pen", color: "#1d2230", size: 6, opacity: 1 } as const;
const STABILIZER = 15;
/** a fresh gallery picture at most this often while drawing (always on close) */
const THUMB_EVERY_MS = 10_000;

export type OpenResult = { ok: true; editor: Editor } | { ok: false; message: string };

/**
 * Open a work for drawing. Holds the work's lock (one window at a time), loads it (recovering the
 * undo history after a crash), and saves automatically until `close()`.
 */
export async function openEditor(store: Store, id: string, onClose: () => void): Promise<OpenResult> {
  const lock = await acquireWorkLock(id).catch(() => null);
  if (!lock) return { ok: false, message: t("workLocked") };
  try {
    const loaded = await store.loadWork(id, Date.now());
    const images = new Map<string, ImageBitmap>();
    for (const [key, blob] of loaded.images) {
      try { images.set(key, await createImageBitmap(blob)); } catch (err) { console.error(err); }
    }
    const editor = new Editor(store, loaded.meta, loaded.doc, images, () => { lock.release(); onClose(); });
    if (loaded.recovered) toast(t("workRecovered"));
    if (loaded.migrated) editor.markDirty();
    return { ok: true, editor };
  } catch (err) {
    lock.release();
    console.error(err);
    return { ok: false, message: err instanceof StorageError && err.kind === "newer" ? t("workNewer") : t("workOpenFailed") };
  }
}

export class Editor {
  readonly el: HTMLElement;
  private readonly desk: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly out: CanvasRenderingContext2D;
  private readonly ring: HTMLElement;
  private readonly pill: HTMLElement;
  private readonly undoBtn: HTMLButtonElement;
  private readonly redoBtn: HTMLButtonElement;
  private readonly zoomBtn: HTMLButtonElement;
  private readonly renderer: PageRenderer;
  private readonly saver: AutoSaver;
  private readonly input: InputController;
  private readonly cleanups: (() => void)[] = [];
  private fit = 1;
  private view: View = IDENTITY;
  private live: StrokeEntry | null = null;
  private predicted: Point[] = [];
  private stab = new Stabilizer(0);
  private raf = 0;
  private lastThumb = 0;
  private askedPersist = false;
  private closing = false;

  constructor(private readonly store: Store, private meta: WorkMeta, private doc: WorkDoc, private readonly images: Map<string, ImageBitmap>, private readonly onClosed: () => void) {
    this.renderer = new PageRenderer({ image: (key) => this.images.get(key) });
    this.canvas = h("canvas", { class: "paper", data: { testid: "paper" } });
    this.out = this.canvas.getContext("2d", { desynchronized: true, alpha: false }) as CanvasRenderingContext2D;
    this.ring = h("div", { class: "hover-ring" });
    this.ring.hidden = true;
    this.zoomBtn = button({ class: "zoom-badge", title: t("zoomFit"), data: { action: "zoom" }, onClick: () => this.setView(IDENTITY, true) });
    this.desk = h("div", { class: "desk" }, this.canvas, this.ring, this.zoomBtn);
    this.pill = h("span", { class: "save-pill", attrs: { role: "status" }, data: { testid: "save" } });
    this.undoBtn = button({ icon: "undo", title: t("undo"), class: "icon-btn", data: { action: "undo" }, onClick: () => this.history(undo) });
    this.redoBtn = button({ icon: "redo", title: t("redo"), class: "icon-btn", data: { action: "redo" }, onClick: () => this.history(redo) });
    const back = button({ icon: "gallery", label: t("gallery"), class: "bar-btn", data: { action: "gallery" }, onClick: () => void this.close() });
    const bar = h("header", { class: "ebar" }, back, h("h1", { class: "work-name", text: meta.name }), this.pill, h("span", { class: "spacer" }), this.undoBtn, this.redoBtn);
    this.el = h("div", { class: "editor" }, bar, this.desk);

    this.saver = new AutoSaver({ save: () => this.save(), onStatus: (s, e) => this.showStatus(s, e) });
    this.showStatus("saved");
    this.input = attachInput(this.desk, {
      frame: () => this.frame(),
      view: () => this.view,
      setView: (v, settled) => this.setView(v, settled),
      strokeStart: (p, kind) => this.strokeStart(p, kind === "pen"),
      strokeMove: (pts, guess) => this.strokeMove(pts, guess),
      strokeEnd: () => this.strokeEnd(),
      strokeCancel: () => { this.live = null; this.predicted = []; this.draw(); },
      undo: () => this.history(undo),
      redo: () => this.history(redo),
      fit: () => this.setView(IDENTITY, true),
      hover: (at) => this.hover(at),
    });
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "z") { e.preventDefault(); this.history(e.shiftKey ? redo : undo); }
      else if (k === "y") { e.preventDefault(); this.history(redo); }
    };
    window.addEventListener("keydown", onKey);
    this.cleanups.push(() => window.removeEventListener("keydown", onKey));
    const ro = new ResizeObserver(() => this.layout());
    ro.observe(this.desk);
    this.cleanups.push(() => ro.disconnect());
    this.cleanups.push(onCanvasRestored(this.canvas, () => { this.renderer.rebuild(); this.draw(); }));
  }

  private get page(): Page { return this.doc.pages[this.doc.current] as Page; }

  private setPage(next: Page): void {
    this.doc = { ...this.doc, pages: this.doc.pages.map((p, i) => (i === this.doc.current ? next : p)) };
  }

  markDirty(): void { this.saver.markDirty(); }

  // ---------- layout and drawing ----------

  private frame(): Frame {
    const r = this.desk.getBoundingClientRect(), s = derive(this.page);
    return { center: [r.left + r.width / 2, r.top + r.height / 2], fit: this.fit, w: s.w, h: s.h };
  }

  private layout(): void {
    const s = derive(this.page), r = this.desk.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    this.fit = fitScale(r.width, r.height, s.w, s.h, 32);
    this.canvas.style.width = `${s.w * this.fit}px`;
    this.canvas.style.height = `${s.h * this.fit}px`;
    this.resolution(true);
    this.place();
    this.draw();
  }

  /** Sharpness follows the zoom: re-render the layers when the needed resolution changed. */
  private resolution(force: boolean): void {
    const s = derive(this.page);
    const dpr = targetDpr(this.fit, this.view.s, window.devicePixelRatio || 1, s.w, s.h);
    if (!force && Math.abs(dpr - this.renderer.resolution) / this.renderer.resolution < 0.05) return;
    this.renderer.setState(s, this.doc.layers, dpr);
    this.canvas.width = this.renderer.width;
    this.canvas.height = this.renderer.height;
  }

  private place(): void {
    const v = this.view;
    this.canvas.style.transform = `translate(${v.tx}px, ${v.ty}px) rotate(${v.r}rad) scale(${v.s})`;
    this.zoomBtn.textContent = t("zoomPercent", { n: zoomPercent(v, this.frame()) });
  }

  private setView(v: View, settled: boolean): void {
    this.view = v;
    this.place();
    if (settled) { this.resolution(false); this.draw(); }
  }

  private draw(): void {
    const entry = this.live && this.predicted.length ? { ...this.live, points: [...this.live.points, ...this.predicted] } : this.live;
    this.renderer.composite(this.out, this.doc.paper, entry ? { kind: "draw", layer: this.page.active, entry } : undefined);
    this.undoBtn.disabled = !canUndo(this.page);
    this.redoBtn.disabled = !canRedo(this.page);
  }

  private redraw(): void {
    if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
  }

  private hover(at: [number, number] | null): void {
    if (!at) { this.ring.hidden = true; return; }
    const d = PEN.size * this.view.s * this.fit, r = this.desk.getBoundingClientRect();
    this.ring.hidden = false;
    this.ring.style.width = this.ring.style.height = `${d}px`;
    this.ring.style.transform = `translate(${at[0] - r.left - d / 2}px, ${at[1] - r.top - d / 2}px)`;
  }

  // ---------- strokes and history ----------

  private strokeStart(p: Point, pressure: boolean): void {
    this.stab = new Stabilizer(STABILIZER);
    this.renderer.prepareStroke(this.page.active);
    this.live = {
      kind: "stroke", brush: PEN.brush, color: PEN.color, size: PEN.size, opacity: PEN.opacity,
      // the stroke keeps the width the user sees on screen, whatever the zoom
      pressure, seed: (Math.random() * 1e9) | 0, vs: this.fit * this.view.s, points: [this.stab.start(p)],
    };
    this.predicted = [];
    this.draw();
  }

  private strokeMove(points: Point[], guess: Point[]): void {
    if (!this.live) return;
    for (const p of points) this.live.points.push(this.stab.add(p));
    this.predicted = this.stab.active ? [] : guess;
    this.redraw();
  }

  private strokeEnd(): void {
    if (!this.live) return;
    this.live.points.push(...this.stab.finish());
    const entry = this.live, layer = this.page.active;
    this.live = null;
    this.predicted = [];
    this.setPage(commit(this.page, { type: "draw", layer, entry }));
    this.renderer.applyDraw(derive(this.page), layer, entry);
    this.draw();
    this.saver.markDirty();
  }

  private history(step: (p: Page) => Page): void {
    if (this.live) return;
    const next = step(this.page);
    if (next === this.page) return;
    this.setPage(next);
    this.renderer.setState(derive(this.page), this.doc.layers);
    this.draw();
    this.saver.markDirty();
  }

  // ---------- saving ----------

  private async thumb(): Promise<Blob | undefined> {
    try { return await this.renderer.thumbnail(this.doc.paper).convertToBlob({ type: "image/webp", quality: 0.85 }); }
    catch (err) { console.error(err); return undefined; }
  }

  private async save(): Promise<void> {
    const now = Date.now();
    const thumb = now - this.lastThumb >= THUMB_EVERY_MS ? await this.thumb() : undefined;
    if (thumb) this.lastThumb = now;
    this.meta = await this.store.saveWork(this.meta.id, { doc: this.doc, now, ...(thumb ? { thumb } : {}) });
    // spec: ask the browser to keep our data after the first successful save
    if (!this.askedPersist) { this.askedPersist = true; void requestPersistence(); }
  }

  private showStatus(s: SaveStatus, err?: unknown): void {
    const quota = s === "error" && err instanceof StorageError && err.kind === "quota";
    this.pill.textContent = quota ? t("saveQuota") : t(s === "saved" ? "saveSaved" : s === "saving" ? "saveSaving" : s === "dirty" ? "saveDirty" : "saveError");
    this.pill.dataset.state = s;
    if (s === "error") console.error(err);
  }

  /** Back to the gallery: save, keep a fresh picture, fold the undo history, release the work. */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.live = null;
    await this.saver.flush();
    this.lastThumb = 0;
    this.saver.markDirty();
    await this.saver.flush();
    if (this.saver.state === "error") {
      // never leave a work whose latest changes are not on the device yet
      this.closing = false;
      toast(t("saveCloseFailed"), 6000);
      return;
    }
    this.input.detach();
    for (const c of this.cleanups) c();
    try {
      await this.store.closeWork(this.meta.id, this.doc, Date.now());
    } catch (err) {
      // everything is saved; only folding the history failed, so it simply comes back next time
      console.error(err);
    }
    this.saver.dispose();
    for (const b of this.images.values()) b.close();
    this.onClosed();
  }
}
