import { BRUSHES, canRedo, canUndo, commit, derive, redo, undo, type Page, type Point, type StrokeEntry, type WorkDoc } from "../core";
import { t } from "../i18n";
import { IDENTITY, Stabilizer, attachInput, toScreen, zoomPercent, type Frame, type InputController, type View } from "../input";
import { PageRenderer, fitScale, onCanvasRestored, targetDpr } from "../render";
import { AutoSaver, StorageError, acquireWorkLock, requestPersistence, type SaveStatus, type Store, type WorkMeta } from "../storage";
import type { Area } from "./dock";
import { button, h } from "./dom";
import { applyPrefsToPage, type Prefs } from "./prefs";
import { openSettings } from "./settings";
import { toast } from "./toast";
import { Toolbar } from "./toolbar";

/** a fresh gallery picture at most this often while drawing (always on close) */
const THUMB_EVERY_MS = 10_000;
/** the size circle stays this long after the size stops changing */
const SIZE_RING_MS = 700;

export interface EditorEnv {
  store: Store;
  prefs: Prefs;
  savePrefs(): void;
}

export type OpenResult = { ok: true; editor: Editor } | { ok: false; message: string };

/**
 * Open a work for drawing. Holds the work's lock (one window at a time), loads it (recovering the
 * undo history after a crash), and saves automatically until `close()`.
 */
export async function openEditor(env: EditorEnv, id: string, onClose: () => void): Promise<OpenResult> {
  const lock = await acquireWorkLock(id).catch(() => null);
  if (!lock) return { ok: false, message: t("workLocked") };
  try {
    const loaded = await env.store.loadWork(id, Date.now());
    const images = new Map<string, ImageBitmap>();
    for (const [key, blob] of loaded.images) {
      try { images.set(key, await createImageBitmap(blob)); } catch (err) { console.error(err); }
    }
    const editor = new Editor(env, loaded.meta, loaded.doc, images, () => { lock.release(); onClose(); });
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
  private readonly work: HTMLElement;
  private readonly desk: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly out: CanvasRenderingContext2D;
  private readonly ring: HTMLElement;
  private readonly sizeRing: HTMLElement;
  private readonly pill: HTMLElement;
  private readonly zoomBtn: HTMLButtonElement;
  private readonly toolbar: Toolbar;
  private readonly renderer: PageRenderer;
  private readonly saver: AutoSaver;
  private readonly input: InputController;
  private readonly store: Store;
  private readonly prefs: Prefs;
  private readonly cleanups: (() => void)[] = [];
  private fit = 1;
  private view: View = IDENTITY;
  private live: StrokeEntry | null = null;
  private predicted: Point[] = [];
  private stab = new Stabilizer(0);
  /** where the pen last touched the paper (paper pixels): the size circle shows there */
  private lastPoint: [number, number] | null = null;
  private sizeTimer = 0;
  private raf = 0;
  private lastThumb = 0;
  private askedPersist = false;
  private closing = false;

  constructor(private readonly env: EditorEnv, private meta: WorkMeta, private doc: WorkDoc, private readonly images: Map<string, ImageBitmap>, private readonly onClosed: () => void) {
    this.store = env.store;
    this.prefs = env.prefs;
    this.renderer = new PageRenderer({ image: (key) => this.images.get(key) });
    this.canvas = h("canvas", { class: "paper", data: { testid: "paper" } });
    this.out = this.canvas.getContext("2d", { desynchronized: true, alpha: false }) as CanvasRenderingContext2D;
    this.ring = h("div", { class: "hover-ring" });
    this.ring.hidden = true;
    this.sizeRing = h("div", { class: "size-ring", data: { testid: "size-ring" } }, h("span"));
    this.sizeRing.hidden = true;
    this.stage = h("div", { class: "stage" }, this.canvas);
    this.desk = h("div", { class: "desk" }, this.stage, this.ring, this.sizeRing);
    this.zoomBtn = button({ class: "zoom-badge", title: t("zoomFit"), data: { action: "zoom" }, onClick: () => this.setView(IDENTITY, true) });
    this.toolbar = new Toolbar({
      prefs: this.prefs,
      savePrefs: () => env.savePrefs(),
      undo: () => this.history(undo),
      redo: () => this.history(redo),
      clear: () => this.clearLayer(),
      area: () => this.area(),
      insetChanged: () => this.applyInset(),
      toolChanged: () => this.ring.hidden = true,
      sizePreview: (show) => this.sizePreview(show),
    });
    this.work = h("div", { class: "work" }, this.desk, this.zoomBtn, this.toolbar.el);
    this.pill = h("span", { class: "save-pill", attrs: { role: "status" }, data: { testid: "save" } });
    const back = button({ icon: "gallery", label: t("gallery"), class: "bar-btn", data: { action: "gallery" }, onClick: () => void this.close() });
    const settings = button({ icon: "settings", title: t("settings"), class: "icon-btn", data: { action: "settings" }, onClick: () => this.settings() });
    const bar = h("header", { class: "ebar" }, back, h("h1", { class: "work-name", text: meta.name }), this.pill, h("span", { class: "spacer" }), settings);
    this.el = h("div", { class: "editor" }, bar, this.work);

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
    }, this.prefs.finger);
    window.addEventListener("keydown", this.onKey);
    this.cleanups.push(() => window.removeEventListener("keydown", this.onKey));
    const ro = new ResizeObserver(() => this.layout());
    ro.observe(this.stage);
    this.cleanups.push(() => ro.disconnect());
    const ro2 = new ResizeObserver(() => this.toolbar.place());
    ro2.observe(this.work);
    this.cleanups.push(() => ro2.disconnect());
    this.cleanups.push(onCanvasRestored(this.canvas, () => { this.renderer.rebuild(); this.draw(); }));
  }

  private readonly onKey = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest("dialog") || (target instanceof HTMLInputElement && target.type !== "range")) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      if (k === "z") { e.preventDefault(); this.history(e.shiftKey ? redo : undo); }
      else if (k === "y") { e.preventDefault(); this.history(redo); }
      return;
    }
    if (e.altKey || e.metaKey) return;
    // 1–8 pick a brush (7 and 8 are the two erasers), [ and ] change the size
    if (/^[1-8]$/.test(k)) { const b = BRUSHES[Number(k) - 1]; if (b) this.toolbar.setBrush(b); }
    else if (k === "[" || k === "]") this.toolbar.sizeBy(k === "]" ? 2 : -2);
  };

  private settings(): void {
    openSettings({
      prefs: this.prefs,
      savePrefs: () => this.env.savePrefs(),
      applied: (what) => {
        if (what === "finger") this.input.setFingerMode(this.prefs.finger);
        if (what === "hand") this.toolbar.handChanged();
        applyPrefsToPage(this.prefs);
      },
      resetToolbar: () => { this.toolbar.reset(); toast(t("setTbResetDone")); },
    });
  }

  private area(): Area {
    const r = this.work.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }

  /** Keep the paper clear of a docked toolbar. */
  private applyInset(): void {
    const i = this.toolbar.insets;
    this.stage.style.left = `${i.left}px`;
    this.stage.style.right = `${i.right}px`;
    this.stage.style.top = `${i.top}px`;
    this.stage.style.bottom = `${i.bottom}px`;
  }

  private get page(): Page { return this.doc.pages[this.doc.current] as Page; }

  private setPage(next: Page): void {
    this.doc = { ...this.doc, pages: this.doc.pages.map((p, i) => (i === this.doc.current ? next : p)) };
  }

  markDirty(): void { this.saver.markDirty(); }

  // ---------- layout and drawing ----------

  private frame(): Frame {
    const r = this.stage.getBoundingClientRect(), s = derive(this.page);
    return { center: [r.left + r.width / 2, r.top + r.height / 2], fit: this.fit, w: s.w, h: s.h };
  }

  private layout(): void {
    const s = derive(this.page), r = this.stage.getBoundingClientRect();
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
    this.toolbar.undoBtn.disabled = !canUndo(this.page);
    this.toolbar.redoBtn.disabled = !canRedo(this.page);
  }

  private redraw(): void {
    if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
  }

  private hover(at: [number, number] | null): void {
    if (!at) { this.ring.hidden = true; return; }
    const d = Math.max(2, this.toolbar.tool.size * this.view.s * this.fit), r = this.desk.getBoundingClientRect();
    this.ring.hidden = false;
    this.ring.style.width = this.ring.style.height = `${d}px`;
    this.ring.style.transform = `translate(${at[0] - r.left - d / 2}px, ${at[1] - r.top - d / 2}px)`;
  }

  /** While the size changes, show the brush as a circle of its real size where the pen last drew. */
  private sizePreview(show: boolean): void {
    clearTimeout(this.sizeTimer);
    if (!show) { this.sizeTimer = window.setTimeout(() => this.sizeRing.classList.remove("on"), SIZE_RING_MS); return; }
    const f = this.frame(), size = this.toolbar.tool.size;
    const at = toScreen(this.view, f, this.lastPoint ?? [f.w / 2, f.h / 2]);
    const r = this.desk.getBoundingClientRect(), d = Math.max(2, size * this.view.s * f.fit);
    this.sizeRing.style.width = this.sizeRing.style.height = `${d}px`;
    this.sizeRing.style.transform = `translate(${at[0] - r.left - d / 2}px, ${at[1] - r.top - d / 2}px)`;
    (this.sizeRing.firstElementChild as HTMLElement).textContent = String(size);
    this.sizeRing.hidden = false;
    this.sizeRing.classList.add("on");
  }

  // ---------- strokes and history ----------

  private strokeStart(p: Point, pressure: boolean): void {
    this.toolbar.closeMenu();
    const tool = this.toolbar.tool;
    this.stab = new Stabilizer(this.prefs.stab);
    this.renderer.prepareStroke(this.page.active);
    this.lastPoint = [p[0], p[1]];
    this.live = {
      kind: "stroke", brush: tool.brush, color: tool.color, size: tool.size, opacity: tool.op / 100,
      // the stroke keeps the width the user sees on screen, whatever the zoom
      pressure, seed: (Math.random() * 1e9) | 0, vs: this.fit * this.view.s, points: [this.stab.start(p)],
    };
    this.predicted = [];
    this.draw();
  }

  private strokeMove(points: Point[], guess: Point[]): void {
    if (!this.live) return;
    for (const p of points) this.live.points.push(this.stab.add(p));
    const last = points[points.length - 1];
    if (last) this.lastPoint = [last[0], last[1]];
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

  private clearLayer(): void {
    if (this.live) return;
    const layer = this.page.active;
    if (!(derive(this.page).layers[layer] ?? []).length) return;
    this.setPage(commit(this.page, { type: "clear", layer }));
    this.renderer.setState(derive(this.page), this.doc.layers);
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
    this.toolbar.destroy();
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
