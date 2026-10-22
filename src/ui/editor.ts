import { BRUSHES, canRedo, canUndo, commit, derive, drawBlock, layersFor, nextId, redo, replaceLast, undo, validActive, type Action, type LayerId, type LayerProps, type Page, type Point, type StrokeEntry, type WorkDoc } from "../core";
import { t } from "../i18n";
import { IDENTITY, Stabilizer, attachInput, toScreen, zoomPercent, type Frame, type InputController, type View } from "../input";
import { PageRenderer, fitScale, onCanvasRestored, targetDpr } from "../render";
import { AutoSaver, StorageError, acquireWorkLock, requestPersistence, type SaveStatus, type Store, type WorkMeta } from "../storage";
import type { Area } from "./dock";
import { button, h } from "./dom";
import { LayersPanel } from "./layers";
import { applyPrefsToPage, remember, type Prefs } from "./prefs";
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
  private readonly panel: LayersPanel;
  private readonly layersBtn: HTMLButtonElement;
  /** the layer whose colour is being dragged in the colour wheel (one undo step for the drag) */
  private bgLive: LayerId | null = null;
  private panelOpen = false;
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
      clear: () => this.clearLayer(this.page.active),
      area: () => this.area(),
      insetChanged: () => this.applyInset(),
      toolChanged: () => this.ring.hidden = true,
      sizePreview: (show) => this.sizePreview(show),
    });
    this.work = h("div", { class: "work" }, this.desk, this.zoomBtn, this.toolbar.el);
    this.panel = new LayersPanel({
      state: () => derive(this.page),
      props: () => this.doc.layers,
      active: () => this.page.active,
      maxLayers: () => this.maxLayers(),
      layerCanvas: (id) => this.renderer.layerCanvas(id),
      area: () => this.area(),
      recentColors: () => this.prefs.paperRecent,
      select: (id) => this.select(id),
      add: () => this.addLayer(),
      duplicate: (id) => this.addLayer(id),
      remove: (id) => this.removeLayer(id),
      merge: (id) => this.mergeDown(id),
      move: (id, to) => this.act({ type: "move", id, to }),
      clear: (id) => this.clearLayer(id),
      bg: (id, color, final) => this.layerColor(id, color, final),
      setProps: (id, patch, final) => this.setLayerProps(id, patch, final),
      exportLayer: (id) => void this.exportLayer(id),
    });
    this.panel.el.addEventListener("closepanel", () => this.showPanel(false));
    this.layersBtn = button({ icon: "layers", label: t("layers"), class: "bar-btn", data: { action: "layers" }, onClick: () => this.showPanel(!this.panelOpen) });
    this.layersBtn.title = t("layersToggle");
    const workspace = h("div", { class: "workspace" }, this.panel.el, this.work);
    this.pill = h("span", { class: "save-pill", attrs: { role: "status" }, data: { testid: "save" } });
    const back = button({ icon: "gallery", label: t("gallery"), class: "bar-btn", data: { action: "gallery" }, onClick: () => void this.close() });
    const settings = button({ icon: "settings", title: t("settings"), class: "icon-btn", data: { action: "settings" }, onClick: () => this.settings() });
    const bar = h("header", { class: "ebar" }, back, h("h1", { class: "work-name", text: meta.name }), this.pill, h("span", { class: "spacer" }), this.layersBtn, settings);
    this.el = h("div", { class: "editor" }, bar, workspace);
    this.showPanel(this.prefs.layersOpen ?? window.innerWidth >= 900, false);

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
    this.panel.closeMenu();
    if (!this.canChange(this.page.active, true)) return;
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
    this.panel.thumbs();
    this.saver.markDirty();
  }

  // ---------- layers ----------

  private maxLayers(): number {
    const s = derive(this.page);
    return Math.max(1, layersFor(s.w, s.h));
  }

  /** Strokes and clearing need a layer that is shown and not locked; say why not otherwise. */
  private canChange(id: LayerId, drawing: boolean): boolean {
    const why = drawBlock(derive(this.page), this.doc.layers, id);
    const name = this.doc.layers[id]?.name ?? id;
    if (why === "locked") { toast(t("layerIsLocked", { name })); return false; }
    if (why === "hidden" && drawing) { toast(t("layerIsHidden", { name })); return false; }
    return why !== "missing";
  }

  /** Commit one change to the page (one undo step) and show it everywhere. */
  private act(a: Action, replace = false): void {
    if (this.live) return;
    this.setPage(replace ? replaceLast(this.page, a) : commit(this.page, a));
    this.refresh();
  }

  /** After the page changed: keep a valid active layer, redraw, update the panel, save soon. */
  private refresh(): void {
    const s = derive(this.page), active = validActive(s, this.page.active);
    if (active && active !== this.page.active) this.setPage({ ...this.page, active });
    this.renderer.setState(s, this.doc.layers);
    this.draw();
    this.panel.update();
    this.saver.markDirty();
  }

  private select(id: LayerId): void {
    if (id === this.page.active) return;
    this.setPage({ ...this.page, active: id });
    this.panel.update();
    this.saver.markDirty();
  }

  /** A new transparent layer above the active one, or a copy of `copyOf` above it. */
  private addLayer(copyOf?: LayerId): void {
    const s = derive(this.page);
    if (s.order.length >= this.maxLayers()) { toast(t("layerFull", { n: this.maxLayers() })); return; }
    const doc: WorkDoc = { ...this.doc, next: { ...this.doc.next }, layers: { ...this.doc.layers } };
    const id = nextId(doc, "layer");
    const from = copyOf ? doc.layers[copyOf] : undefined;
    const props: LayerProps = from ? { ...from, name: t("layerCopyName", { name: from.name }), locked: false } : { name: t("layerDefaultName", { n: doc.next.layer }), visible: true, opacity: 1 };
    doc.layers[id] = props;
    this.doc = doc;
    const at = s.order.indexOf(copyOf ?? this.page.active) + 1;
    this.setPage({ ...commit(this.page, { type: "add", id, index: at, ...(copyOf ? { copyOf } : {}) }), active: id });
    this.refresh();
  }

  private removeLayer(id: LayerId): void {
    const s = derive(this.page), i = s.order.indexOf(id);
    if (i < 0 || s.order.length <= 1 || this.doc.layers[id]?.locked) return;
    // the layer below becomes active (or the one above when deleting the bottom layer)
    const next = s.order[i - 1] ?? s.order[i + 1];
    this.setPage(commit(this.page, { type: "del", id }));
    if (id === this.page.active && next) this.setPage({ ...this.page, active: next });
    this.refresh();
  }

  private mergeDown(id: LayerId): void {
    const s = derive(this.page), i = s.order.indexOf(id), into = s.order[i - 1];
    if (!into || this.doc.layers[id]?.locked || this.doc.layers[into]?.locked) return;
    this.setPage({ ...commit(this.page, { type: "merge", id, into, alpha: this.doc.layers[id]?.opacity ?? 1 }), active: into });
    this.refresh();
  }

  private clearLayer(id: LayerId): void {
    if (this.live || !this.canChange(id, false)) return;
    const L = derive(this.page).layers[id] ?? [];
    if (!L.some((e) => e.kind !== "bg" || e.holes.length > 0)) return;
    this.act({ type: "clear", layer: id });
  }

  private layerColor(id: LayerId, color: string | null, final: boolean): void {
    this.act({ type: "bg", layer: id, color }, this.bgLive === id);
    this.bgLive = final ? null : id;
    if (final && color && color !== "#ffffff" && color !== "#fbf7ee") { this.prefs.paperRecent = remember(this.prefs.paperRecent, color); this.env.savePrefs(); }
  }

  /** Name, visibility, opacity and lock are settings, not undo steps. */
  private setLayerProps(id: LayerId, patch: Partial<LayerProps>, final: boolean): void {
    const cur = this.doc.layers[id];
    if (!cur) return;
    this.doc = { ...this.doc, layers: { ...this.doc.layers, [id]: { ...cur, ...patch } } };
    this.renderer.setProps(this.doc.layers);
    this.draw();
    if (final) { this.panel.update(); this.saver.markDirty(); }
  }

  private async exportLayer(id: LayerId): Promise<void> {
    try {
      const s = derive(this.page), name = this.doc.layers[id]?.name ?? id;
      // drawn again at the paper's full size, with only this layer showing
      const r = new PageRenderer({ image: (key) => this.images.get(key) });
      r.setState(s, Object.fromEntries(s.order.map((l) => [l, { name: l, visible: l === id, opacity: l === id ? (this.doc.layers[id]?.opacity ?? 1) : 0 }])), 1);
      const blob = await r.flatten().convertToBlob({ type: "image/png" });
      const url = URL.createObjectURL(blob);
      const a = h("a", { attrs: { href: url, download: `${this.meta.name} - ${name}.png` } });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      console.error(err);
      toast(t("actionFailed"));
    }
  }

  private showPanel(open: boolean, store = true): void {
    this.panelOpen = open;
    this.panel.el.hidden = !open;
    this.layersBtn.setAttribute("aria-pressed", String(open));
    if (open) this.panel.update();
    if (store) { this.prefs.layersOpen = open; this.env.savePrefs(); }
    // the paper area changed size
    requestAnimationFrame(() => this.toolbar.place());
  }

  private history(step: (p: Page) => Page): void {
    if (this.live) return;
    const next = step(this.page);
    if (next === this.page) return;
    this.bgLive = null;
    this.setPage(next);
    this.refresh();
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
    this.panel.destroy();
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
