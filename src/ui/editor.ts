import { BRUSHES, LIMITS, allMask, canRedo, canUndo, commit, deleteMany, derive, mergeMany, drawBlock, fontsInUse, inMask, invert, invertMask, layersFor, maskBounds, mul, newPage, nextId, paperFill, rectMask, redo, replaceLast, shiftMask, thinOutline, undo, usableMask, validActive, type DrawEntry, type Mask, type Action, type ImageEntry, type LayerId, type LayerProps, type Mat, type Page, type PageState, type Point, type StrokeEntry, type TextData, type WorkDoc } from "../core";
import { t } from "../i18n";
import { IDENTITY, Stabilizer, attachInput, toScreen, zoomPercent, type Frame, type InputController, type View } from "../input";
import { PageRenderer, clipTo, drawText, fitScale, hitText, makeCanvas, ctx2d, measureText, onCanvasRestored, targetDpr } from "../render";
import { AutoSaver, StorageError, acquireWorkLock, requestPersistence, type SaveStatus, type Store, type WorkMeta } from "../storage";
import type { Area } from "./dock";
import { button, h } from "./dom";
import { ensureFont, ensureFonts, loadImportedFonts } from "./fonts";
import { LayersPanel } from "./layers";
import { TextSession, type TextTarget } from "./textTool";
import { TransformFrame } from "./transform";
import { SelectionOutline } from "./selection";
import type { MenuItem } from "./toolbar";
import { openExport } from "./exporter";
import { PageStrip } from "./pages";
import { askNewPage, openPaperDialog } from "./paperDialog";
import { applyPrefsToPage, remember, type Prefs } from "./prefs";
import { meter, openDiagnostics, trackStroke } from "./diagnostics";
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

/** spec: a layer added with + starts as white paper */
const NEW_LAYER_COLOR = "#ffffff";

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
  /** shown while a selection is kept: drawing stays inside it until this is pressed */
  private readonly selChip: HTMLElement;
  private readonly toolbar: Toolbar;
  private readonly panel: LayersPanel;
  private readonly layersBtn: HTMLButtonElement;
  /** the layer whose colour is being dragged in the colour wheel (one undo step for the drag) */
  private bgLive: LayerId | null = null;
  private panelOpen = false;
  private mode: "draw" | "text" | "move" | "select" = "draw";
  /** the selection (paper pixels); strokes are limited to it while it exists */
  private sel: Mask | null = null;
  private selShape: "rect" | "lasso" = "rect";
  /** a selection being drawn, or the selected pixels being dragged */
  private selDrag: { kind: "new"; pts: [number, number][] } | { kind: "move"; start: [number, number]; dx: number; dy: number; layer: LayerId } | null = null;
  /** what the dragged selection looks like (shown, not kept yet) */
  private selLive: DrawEntry | null = null;
  private readonly outline = new SelectionOutline();
  /** the move / scale / turn frame: its layer, what has been kept so far, and the drag being shown */
  private frameBox: { frame: TransformFrame; layer: LayerId; kept: Mat | null; live: Mat | null } | null = null;
  private readonly fileIn: HTMLInputElement;
  private readonly strip: PageStrip;
  private readonly paperBtn: HTMLButtonElement;
  private stripTimer = 0;
  /** paper size the view was last laid out for */
  private laidOut = { w: 0, h: 0 };
  private text: TextSession | null = null;
  /** pictures made in this session (text turned into a picture) that are not saved yet */
  private readonly pendingImages = new Map<string, Blob>();
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
  private readonly nameBtn: HTMLButtonElement;
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
    this.selChip = h("div", { class: "sel-chip", attrs: { role: "status" }, data: { testid: "sel-chip" } },
      h("span", { text: t("selKeptNote") }),
      button({ icon: "deselect", label: t("selectNone"), class: "primary", data: { action: "sel-clear" }, onClick: () => this.setSel(null) }));
    this.selChip.hidden = true;
    this.zoomBtn = button({ class: "zoom-badge", title: t("zoomFit"), data: { action: "zoom" }, onClick: () => this.setView(IDENTITY, true) });
    this.toolbar = new Toolbar({
      prefs: this.prefs,
      savePrefs: () => env.savePrefs(),
      undo: () => this.history(undo),
      redo: () => this.history(redo),
      clear: () => this.clearLayer(this.page.active),
      area: () => this.area(),
      insetChanged: () => this.applyInset(),
      toolChanged: () => { this.ring.hidden = true; if (this.text?.open) this.text.setColor(this.prefs.color); },
      toggleText: () => this.setMode(this.mode === "text" ? "draw" : "text"),
      toDraw: () => { if (this.mode !== "draw") this.setMode("draw"); },
      textMode: () => this.mode === "text",
      toggleMove: () => this.setMode(this.mode === "move" ? "draw" : "move"),
      moveMode: () => this.mode === "move",
      selectMode: () => this.mode === "select",
      selectItems: () => this.selectItems(),
      sizePreview: (show) => this.sizePreview(show),
    });
    this.work = h("div", { class: "work" }, this.desk, this.outline.el, this.selChip, this.zoomBtn, this.toolbar.el);
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
      removeMany: (ids) => this.removeLayers(ids),
      mergeMany: (ids) => this.mergeLayers(ids),
      setPropsMany: (ids, patch) => this.setManyProps(ids, patch),
      exportLayer: (id) => void this.exportLayer(id),
      importImage: () => this.fileIn.click(),
    });
    this.panel.el.addEventListener("closepanel", () => this.showPanel(false));
    this.fileIn = h("input", { attrs: { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/bmp", hidden: "" }, data: { field: "image-file" } });
    this.fileIn.addEventListener("change", () => { const f = this.fileIn.files?.[0]; this.fileIn.value = ""; if (f) void this.importImage(f); });
    this.layersBtn = button({ icon: "layers", label: t("layers"), class: "bar-btn", data: { action: "layers" }, onClick: () => this.showPanel(!this.panelOpen) });
    this.layersBtn.title = t("layersToggle");
    const workspace = h("div", { class: "workspace" }, this.panel.el, this.work);
    this.pill = h("span", { class: "save-pill", attrs: { role: "status" }, data: { testid: "save" } });
    const back = button({ icon: "gallery", label: t("gallery"), class: "bar-btn", data: { action: "gallery" }, onClick: () => void this.close() });
    const settings = button({ icon: "settings", title: t("settings"), class: "icon-btn", data: { action: "settings" }, onClick: () => this.settings() });
    this.strip = new PageStrip({
      doc: () => this.doc,
      currentThumb: (max) => this.renderer.thumbnail(this.doc.paper, max),
      image: (key) => this.images.get(key),
      open: (i) => this.openPage(i),
      add: () => void this.addPage(),
      duplicate: () => this.duplicatePage(),
      remove: () => this.removePage(),
    });
    this.paperBtn = button({ label: t("paperLabel"), title: t("paperButton"), class: "bar-btn paper-btn", data: { action: "paper" }, onClick: () => this.paperDialog() });
    this.paperBtn.prepend(h("i", { class: "pdot paper-dot" }));
    const exportBtn = button({ icon: "download", label: t("exportButton"), class: "bar-btn", data: { action: "export" }, onClick: () => { this.text?.finish(); this.setMode("draw"); openExport({ doc: () => this.doc, workName: () => this.meta.name, image: (key) => this.images.get(key) }); } });
    this.nameBtn = button({ label: meta.name, class: "work-name", data: { action: "work-name" }, onClick: () => this.editName() });
    this.nameBtn.title = t("workRename");
    const bar = h("header", { class: "ebar" }, back, h("h1", { class: "work-title" }, this.nameBtn), this.pill, this.strip.el, this.paperBtn, exportBtn, this.layersBtn, settings);
    this.el = h("div", { class: "editor" }, bar, workspace, this.fileIn);
    // a picture dropped on the paper becomes a new layer
    this.work.addEventListener("dragover", (e) => { if (e.dataTransfer?.types.includes("Files")) e.preventDefault(); });
    this.work.addEventListener("drop", (e) => { const f = e.dataTransfer?.files[0]; if (f && f.type.startsWith("image/")) { e.preventDefault(); void this.importImage(f); } });
    this.showPanel(this.prefs.layersOpen ?? window.innerWidth >= 900, false);

    this.saver = new AutoSaver({ save: () => this.save(), onStatus: (s, e) => this.showStatus(s, e) });
    this.showStatus("saved");
    this.input = attachInput(this.desk, {
      frame: () => this.frame(),
      view: () => this.view,
      setView: (v, settled) => this.setView(v, settled),
      strokeStart: (p, kind, erase) => { trackStroke(kind, p[3]); this.strokeStart(p, kind === "pen", erase); },
      strokeMove: (pts, guess) => { meter.points(pts.map((p) => p[3])); this.strokeMove(pts, guess); },
      strokeEnd: () => { meter.end(); this.strokeEnd(); },
      strokeCancel: () => { meter.cancel(); this.live = null; this.predicted = []; this.selDrag = null; this.selLive = null; this.showSel(); this.draw(); },
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
    void this.loadFonts();
    this.syncPaper();
    requestAnimationFrame(() => { if (!this.closing) this.strip.update(); });
  }

  /** Type the work's new name right in the top bar: Enter or tapping elsewhere keeps it, Escape does not. */
  private editName(): void {
    const old = this.meta.name;
    const input = h("input", { class: "work-name-input", attrs: { type: "text", maxlength: "60", "aria-label": t("workName") }, data: { field: "work-name" } });
    input.value = old;
    this.nameBtn.replaceWith(input);
    let done = false;
    const finish = (keep: boolean) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      input.replaceWith(this.nameBtn);
      if (!keep || !name || name === old) return;
      this.showName(name);
      this.store.renameWork(this.meta.id, name)
        .then((m) => { this.meta = { ...this.meta, name: m.name }; })
        .catch((err: unknown) => { console.error(err); toast(t("actionFailed")); this.showName(old); });
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
    input.focus();
    input.select();
  }

  private showName(name: string): void {
    this.meta = { ...this.meta, name };
    (this.nameBtn.querySelector("span") as HTMLElement).textContent = name;
  }

  private readonly onKey = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest("dialog, textarea") || (target instanceof HTMLInputElement && target.type !== "range")) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      if (k === "z") { e.preventDefault(); this.history(e.shiftKey ? redo : undo); }
      else if (k === "y") { e.preventDefault(); this.history(redo); }
      else if (k === "a") { e.preventDefault(); this.selectAll(); }
      else if (k === "d") { e.preventDefault(); this.setSel(null); }
      else if (k === "i" && e.shiftKey) { e.preventDefault(); if (this.sel) this.setSel(invertMask(this.sel)); }
      else if (k === "j") { e.preventDefault(); void this.copySelection(false); }
      return;
    }
    if (e.altKey || e.metaKey) return;
    // 1–8 pick a brush (7 and 8 are the two erasers), [ and ] change the size
    if (/^[1-8]$/.test(k)) { const b = BRUSHES[Number(k) - 1]; if (b) { this.setMode("draw"); this.toolbar.setBrush(b); } }
    else if (k === "t") this.setMode(this.mode === "text" ? "draw" : "text");
    else if (k === "v") this.setMode(this.mode === "move" ? "draw" : "move");
    else if ((k === "enter" || k === "escape") && this.mode === "move") this.setMode("draw");
    else if (k === "s") this.setMode(this.mode === "select" ? "draw" : "select");
    else if (k === "escape" && this.sel) this.setSel(null);
    else if ((k === "delete" || k === "backspace") && this.sel) { e.preventDefault(); this.deleteSelection(); }
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
      diagnostics: () => openDiagnostics({ work: () => { const s = derive(this.page); return { layers: s.order.length, w: s.w, h: s.h }; } }),
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
    this.laidOut = { w: s.w, h: s.h };
    this.canvas.style.width = `${s.w * this.fit}px`;
    this.canvas.style.height = `${s.h * this.fit}px`;
    this.resolution(true);
    this.place();
    this.showSel();
    this.draw();
  }

  /** Sharpness follows the zoom: re-render the layers when the needed resolution changed. */
  private resolution(force: boolean): void {
    const s = this.shown();
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
    this.text?.place();
    this.frameBox?.frame.place();
    this.showSel();
    if (settled) { this.resolution(false); this.draw(); }
  }

  private draw(): void {
    const entry = this.live && this.predicted.length ? { ...this.live, points: [...this.live.points, ...this.predicted] } : this.live;
    const fb = this.frameBox, drawn = entry ?? this.selLive;
    this.renderer.composite(this.out, this.doc.paper, drawn ? { kind: "draw", layer: this.page.active, entry: drawn } : fb?.live ? { kind: "move", layer: fb.layer, m: fb.live } : undefined);
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

  private strokeStart(p: Point, pressure: boolean, erase = false): void {
    this.toolbar.closeMenu();
    this.panel.closeMenu();
    if (this.mode === "text") { this.textTap(p); return; }
    if (this.mode === "move") return; // outside the frame: nothing to draw
    if (this.mode === "select") { this.selectStart(p); return; }
    if (!this.canChange(this.page.active, true)) return;
    // the pen's side button (or eraser end) erases this one stroke, with the eraser's own size
    let tool = this.toolbar.tool;
    if (erase && this.mode === "draw") {
      const ek = this.prefs.eraser, s = this.prefs.brushes[ek];
      tool = { ...tool, brush: ek, size: s.size, op: s.op };
      if (!this.prefs.penButtonSeen) { this.prefs.penButtonSeen = true; this.env.savePrefs(); toast(t("penButtonFound"), 5000); }
    }
    this.stab = new Stabilizer(this.prefs.stab);
    this.renderer.prepareStroke(this.page.active);
    this.lastPoint = [p[0], p[1]];
    this.live = {
      kind: "stroke", brush: tool.brush, color: tool.color, size: tool.size, opacity: tool.op / 100,
      // the stroke keeps the width the user sees on screen, whatever the zoom
      pressure, seed: (Math.random() * 1e9) | 0, vs: this.fit * this.view.s, points: [this.stab.start(p)],
      // with a selection, drawing (and erasing) stays inside it
      ...(this.sel ? { mask: this.sel } : {}),
    };
    this.predicted = [];
    this.draw();
  }

  private strokeMove(points: Point[], guess: Point[]): void {
    if (this.selDrag) { const last = points[points.length - 1]; if (last) this.selectMove(points, last); return; }
    if (!this.live) return;
    for (const p of points) this.live.points.push(this.stab.add(p));
    const last = points[points.length - 1];
    if (last) this.lastPoint = [last[0], last[1]];
    // shown at once (not a frame later): the line up to the pen, plus where the pen is about to be
    this.predicted = [...this.stab.tail(), ...guess];
    this.draw();
  }

  private strokeEnd(): void {
    if (this.selDrag) { this.selectEnd(); return; }
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
    this.stripSoon();
  }

  // ---------- text ----------

  /** The page as shown: while a text is being edited it is left out (the typing box stands in for it). */
  private shown(): PageState {
    const s = derive(this.page), tgt = this.text?.open ? this.text.target : null;
    if (tgt && s.layers[tgt.layer]) s.layers[tgt.layer] = (s.layers[tgt.layer] ?? []).filter((e) => !(e.kind === "text" && e.tid === tgt.tid));
    return s;
  }

  /** Fonts used in this work (and imported ones) become ready; then text is drawn again in them. */
  private async loadFonts(): Promise<void> {
    await loadImportedFonts(this.store);
    await ensureFonts(fontsInUse(this.doc));
    if (!this.closing) { this.renderer.setState(this.shown(), this.doc.layers); this.draw(); this.panel.thumbs(); }
  }

  private setMode(m: "draw" | "text" | "move" | "select"): void {
    if (m === this.mode) return;
    this.text?.finish();
    this.closeFrame();
    this.mode = m;
    this.desk.classList.toggle("texting", m === "text");
    this.desk.classList.toggle("selecting", m === "select");
    this.ring.hidden = true;
    if (m === "text") toast(t("textHint"));
    if (m === "select") toast(t("selectHint"));
    if (m === "move" && !this.openFrame()) this.mode = "draw";
    this.toolbar.sync();
  }

  // ---------- selection ----------

  private selectItems(): MenuItem[] {
    const has = !!this.sel, sep = { key: "selectTool", icon: "select", enabled: false, data: "-", act: () => undefined } as const;
    const shape = (v: "rect" | "lasso") => () => { this.selShape = v; this.setMode("select"); this.toolbar.sync(); };
    return [
      { key: "selectRect", icon: "rect", enabled: true, checked: this.mode === "select" && this.selShape === "rect", kbd: "S", data: "rect", act: shape("rect") },
      { key: "selectLasso", icon: "lasso", enabled: true, checked: this.mode === "select" && this.selShape === "lasso", data: "lasso", act: shape("lasso") },
      sep,
      { key: "selectAll", icon: "selectAll", enabled: true, kbd: "Ctrl+A", data: "all", act: () => this.selectAll() },
      { key: "selectInvert", icon: "invert", enabled: has, kbd: "Ctrl+Shift+I", data: "invert", act: () => { if (this.sel) this.setSel(invertMask(this.sel)); } },
      { key: "selectNone", icon: "deselect", enabled: has, kbd: "Ctrl+D", data: "none", act: () => this.setSel(null) },
      sep,
      { key: "selectCopy", icon: "copy", enabled: has, kbd: "Ctrl+J", data: "copy", act: () => void this.copySelection(false) },
      { key: "selectCut", icon: "cut", enabled: has, data: "cut", act: () => void this.copySelection(true) },
      { key: "selectDelete", icon: "trash", enabled: has, kbd: "Delete", data: "delete", act: () => this.deleteSelection() },
    ];
  }

  private setSel(m: Mask | null): void {
    this.sel = m;
    this.showSel();
  }

  private selectAll(): void {
    const s = derive(this.page);
    this.setSel(allMask(s.w, s.h));
  }

  /** Draw the outline: the selection, the one being drawn, or where the dragged pixels are going. */
  private showSel(): void {
    const d = this.selDrag;
    let m = this.sel, closed = true;
    if (d?.kind === "new") {
      const a = d.pts[0], b = d.pts[d.pts.length - 1];
      m = this.selShape === "rect" && a && b ? rectMask(a[0], a[1], b[0], b[1]) : { pts: d.pts, inv: false };
      closed = this.selShape === "rect";
    } else if (d?.kind === "move" && m) m = shiftMask(m, d.dx, d.dy);
    this.outline.show(m, this.frame(), this.view, this.work.getBoundingClientRect(), closed);
    this.selChip.hidden = !this.sel || !!d;
  }

  /** Press with the select tool: inside the selection drags its pixels, elsewhere starts a new selection. */
  private selectStart(p: Point): void {
    const layer = this.page.active;
    if (this.sel && inMask(this.sel, p[0], p[1])) {
      if (!this.canChange(layer, true)) return;
      this.renderer.prepareStroke(layer);
      this.selDrag = { kind: "move", start: [p[0], p[1]], dx: 0, dy: 0, layer };
      return;
    }
    this.selDrag = { kind: "new", pts: [[p[0], p[1]]] };
    this.showSel();
  }

  private selectMove(points: Point[], last: Point): void {
    const d = this.selDrag;
    if (!d) return;
    if (d.kind === "new") {
      if (this.selShape === "rect") d.pts = [d.pts[0] as [number, number], [last[0], last[1]]];
      else for (const p of points) d.pts.push([p[0], p[1]]);
    } else if (this.sel) {
      d.dx = last[0] - d.start[0];
      d.dy = last[1] - d.start[1];
      this.selLive = { kind: "selmove", mask: this.sel, dx: d.dx, dy: d.dy };
      this.redraw();
    }
    this.showSel();
  }

  private selectEnd(): void {
    const d = this.selDrag;
    this.selDrag = null;
    this.selLive = null;
    if (!d) return;
    if (d.kind === "new") {
      const a = d.pts[0], b = d.pts[d.pts.length - 1];
      const m: Mask = this.selShape === "rect" && a && b ? rectMask(a[0], a[1], b[0], b[1]) : { pts: thinOutline(d.pts), inv: false };
      // a tap (or a tiny outline) clears the selection
      this.setSel(usableMask(m) ? m : null);
      return;
    }
    if (this.sel && (Math.abs(d.dx) > 0.5 || Math.abs(d.dy) > 0.5)) {
      const entry: DrawEntry = { kind: "selmove", mask: this.sel, dx: d.dx, dy: d.dy };
      this.sel = shiftMask(this.sel, d.dx, d.dy);
      this.act({ type: "draw", layer: d.layer, entry });
    } else this.draw();
    this.showSel();
  }

  private deleteSelection(): void {
    const layer = this.page.active;
    if (!this.sel || !this.canChange(layer, false)) return;
    this.act({ type: "draw", layer, entry: { kind: "selerase", mask: this.sel } });
  }

  /** The selected part of the chosen layer as a picture on a new layer above it; "cut" also removes it (two steps). */
  private async copySelection(cut: boolean): Promise<void> {
    const sel = this.sel, layer = this.page.active;
    if (!sel) return;
    const s = derive(this.page), b = maskBounds(sel, s.w, s.h);
    if (!b) { toast(t("selectOutside")); return; }
    if (s.order.length >= this.maxLayers()) { toast(t("layerFull", { n: this.maxLayers() })); return; }
    if (cut && !this.canChange(layer, false)) return;
    try {
      // this layer alone at the paper's full size, then only what is inside the selection
      const r = new PageRenderer({ image: (key) => this.images.get(key) });
      r.setState(s, Object.fromEntries(s.order.map((id) => [id, { name: id, visible: id === layer, opacity: 1 }])), 1);
      const full = r.flatten();
      const clipped = makeCanvas(s.w, s.h), cx = ctx2d(clipped);
      cx.save(); clipTo(cx, sel, 1); cx.drawImage(full, 0, 0); cx.restore();
      const part = makeCanvas(b.w, b.h);
      ctx2d(part).drawImage(clipped, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
      const blob = await part.convertToBlob({ type: "image/webp", quality: 0.95 });
      const doc: WorkDoc = { ...this.doc, next: { ...this.doc.next }, layers: { ...this.doc.layers } };
      const img = nextId(doc, "image"), id = nextId(doc, "layer"), from = doc.layers[layer];
      doc.layers[id] = { name: t("selectLayerName", { name: from?.name ?? layer }), visible: true, opacity: from?.opacity ?? 1 };
      this.doc = doc;
      this.images.set(img, await createImageBitmap(part));
      this.pendingImages.set(img, blob);
      if (cut) this.setPage(commit(this.page, { type: "draw", layer, entry: { kind: "selerase", mask: sel } }));
      const image: ImageEntry = { kind: "image", img, x: b.x, y: b.y, w: b.w, h: b.h, opacity: 1 };
      this.setPage({ ...commit(this.page, { type: "add", id, index: s.order.indexOf(layer) + 1, image }), active: id });
      this.refresh();
      toast(t(cut ? "selectCutDone" : "selectCopied"));
    } catch (err) {
      console.error(err);
      toast(t("actionFailed"));
    }
  }

  // ---------- move, scale, turn ----------

  /** Put the frame around the active layer's content. False when there is nothing to move. */
  private openFrame(): boolean {
    const layer = this.page.active, name = this.doc.layers[layer]?.name ?? layer;
    if (!this.canChange(layer, false)) return false;
    const box = this.renderer.contentBounds(layer);
    if (!box) { toast(t("moveEmpty", { name })); return false; }
    const frame = new TransformFrame({
      frame: () => this.frame(),
      view: () => this.view,
      container: () => this.work,
      preview: (m) => { if (this.frameBox) { this.frameBox.live = this.frameBox.kept ? mul(m, invert(this.frameBox.kept)) : m; this.redraw(); } },
      commit: (m) => this.keepMove(m),
      done: () => this.setMode("draw"),
    }, box);
    this.frameBox = { frame, layer, kept: null, live: null };
    return true;
  }

  /** A drag in the frame ended: one undo step for the whole time the frame is open. */
  private keepMove(m: Mat): void {
    const fb = this.frameBox;
    if (!fb) return;
    const a: Action = { type: "xform", layer: fb.layer, m };
    const last = this.page.actions[this.page.actions.length - 1];
    // replace our own earlier step only if nothing else happened in between
    this.setPage(fb.kept && last?.type === "xform" && last.layer === fb.layer ? replaceLast(this.page, a) : commit(this.page, a));
    fb.kept = m;
    fb.live = null;
    this.refresh();
  }

  private closeFrame(): void {
    const fb = this.frameBox;
    if (!fb) return;
    fb.frame.remove();
    this.frameBox = null;
    // a drag still showing (not kept) goes away with the frame
    if (fb.live) this.draw();
  }

  // ---------- pictures ----------

  /** A picture file becomes a new layer, fitted inside the paper, with the frame on it to place it. */
  private async importImage(file: File): Promise<void> {
    if (file.size > 50 * 1024 * 1024) { toast(t("imageTooBig")); return; }
    const s = derive(this.page);
    if (s.order.length >= this.maxLayers()) { toast(t("layerFull", { n: this.maxLayers() })); return; }
    let blob: Blob, bmp: ImageBitmap;
    try { ({ blob, bmp } = await decodePicture(file, s.w, s.h)); }
    catch (err) { console.error(err); toast(t("imageFailed")); return; }
    this.setMode("draw");
    const doc: WorkDoc = { ...this.doc, next: { ...this.doc.next }, layers: { ...this.doc.layers } };
    const img = nextId(doc, "image"), id = nextId(doc, "layer");
    const name = file.name.replace(/\.[^.]+$/, "").trim().slice(0, 60) || t("imageLayerName");
    doc.layers[id] = { name, visible: true, opacity: 1 };
    this.doc = doc;
    this.images.set(img, bmp);
    this.pendingImages.set(img, blob);
    // at most 80% of the paper, centred
    const k = Math.min(1, (s.w * 0.8) / bmp.width, (s.h * 0.8) / bmp.height), w = bmp.width * k, h = bmp.height * k;
    const image: ImageEntry = { kind: "image", img, x: (s.w - w) / 2, y: (s.h - h) / 2, w, h, opacity: 1 };
    this.setPage({ ...commit(this.page, { type: "add", id, index: s.order.indexOf(this.page.active) + 1, image }), active: id });
    this.refresh();
    this.setMode("move");
  }

  /** A tap with the text tool: edit the text under it, or start a new box there. */
  private textTap(p: Point): void {
    this.text?.finish();
    const s = derive(this.page);
    for (const id of [...s.order].reverse()) {
      if (this.doc.layers[id]?.visible === false) continue;
      const hit = (s.layers[id] ?? []).find((e) => e.kind === "text" && hitText(e, p[0], p[1]));
      if (hit?.kind !== "text") continue;
      if (this.doc.layers[id]?.locked) { toast(t("layerIsLocked", { name: this.doc.layers[id]?.name ?? id })); return; }
      const { tid, x, y, text, font, size, color, align, rot } = hit;
      this.openText({ tid, x, y, text, font, size, color, align, rot }, { layer: id, tid });
      return;
    }
    const pt = this.prefs.text;
    const tid = `T${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    this.openText({ tid, x: p[0], y: p[1] - pt.size * 0.7, text: "", font: pt.font, size: pt.size, color: this.prefs.color, align: pt.align, rot: 0 }, null);
  }

  private openText(data: TextData, target: TextTarget | null): void {
    this.text = new TextSession({
      prefs: this.prefs,
      savePrefs: () => this.env.savePrefs(),
      store: this.store,
      frame: () => this.frame(),
      view: () => this.view,
      container: () => this.work,
      insets: () => this.toolbar.insets,
      finish: (d, tg) => { this.saveText(d, tg); },
      remove: (tg) => { this.text = null; if (tg) this.act({ type: "textset", layer: tg.layer, tid: tg.tid, text: null }); else this.refresh(); },
      flatten: (d, tg) => void this.flattenText(d, tg),
    }, data, target);
    // hide the original while it is being edited
    if (target) { this.renderer.setState(this.shown(), this.doc.layers); this.draw(); }
  }

  /** One undo step: a new text layer, or the changed (or emptied) text. */
  private saveText(d: TextData, tg: TextTarget | null): TextTarget | null {
    this.text = null;
    // the box size is kept so the move tool can turn the text around its middle
    const box = measureText(d);
    d.w = box.w;
    d.h = box.h;
    // committed straight away (undo and closing come right after); drawn again once its font is in
    void ensureFont(d.font).then((ok) => { if (ok && !this.closing) { this.renderer.setState(this.shown(), this.doc.layers); this.draw(); this.panel.thumbs(); } });
    const empty = !d.text.trim();
    if (!tg) {
      if (empty) { this.refresh(); return null; }
      const s = derive(this.page);
      if (s.order.length >= this.maxLayers()) { toast(t("layerFull", { n: this.maxLayers() })); this.refresh(); return null; }
      const doc: WorkDoc = { ...this.doc, next: { ...this.doc.next }, layers: { ...this.doc.layers } };
      const id = nextId(doc, "layer");
      const first = d.text.trim().split("\n")[0]?.slice(0, 40) || t("textLayerName");
      doc.layers[id] = { name: first, visible: true, opacity: 1 };
      this.doc = doc;
      const at = s.order.indexOf(this.page.active) + 1;
      this.setPage({ ...commit(this.page, { type: "add", id, index: at, text: d }), active: id });
      this.refresh();
      return { layer: id, tid: d.tid };
    }
    const before = (derive(this.page).layers[tg.layer] ?? []).find((e) => e.kind === "text" && e.tid === tg.tid);
    const same = before?.kind === "text" && (["x", "y", "text", "font", "size", "color", "align", "rot", "w", "h"] as const).every((k) => before[k] === d[k]);
    if (same) { this.refresh(); return tg; }
    this.act({ type: "textset", layer: tg.layer, tid: tg.tid, text: empty ? null : d });
    return empty ? null : tg;
  }

  /** Save the text, then turn it into a picture of the whole page size (one more undo step). */
  private async flattenText(d: TextData, tg: TextTarget | null): Promise<void> {
    const saved = this.saveText(d, tg);
    if (!saved) return;
    try {
      const s = derive(this.page);
      const c = makeCanvas(s.w, s.h);
      drawText(ctx2d(c), d, { dpr: 1, w: s.w, h: s.h, image: () => undefined });
      const blob = await c.convertToBlob({ type: "image/png" });
      const doc: WorkDoc = { ...this.doc, next: { ...this.doc.next } };
      const img = nextId(doc, "image");
      this.doc = doc;
      this.images.set(img, await createImageBitmap(blob));
      this.pendingImages.set(img, blob);
      this.act({ type: "textflat", layer: saved.layer, tid: saved.tid, img, w: s.w, h: s.h });
    } catch (err) {
      console.error(err);
      toast(t("actionFailed"));
    }
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
    // the paper changed size (resize, or undoing one): lay the view out again
    if (s.w !== this.laidOut.w || s.h !== this.laidOut.h) { this.sel = null; this.showSel(); this.view = IDENTITY; this.layout(); this.panel.update(); this.saver.markDirty(); this.stripSoon(); return; }
    this.renderer.setState(this.shown(), this.doc.layers);
    this.draw();
    this.panel.update();
    this.saver.markDirty();
    this.stripSoon();
  }

  /** The page chips show the open page; redrawn shortly after a change, not on every stroke point. */
  private stripSoon(): void {
    clearTimeout(this.stripTimer);
    this.stripTimer = window.setTimeout(() => { if (!this.closing) this.strip.update(); }, 400);
  }

  // ---------- pages and paper ----------

  private paperDialog(): void {
    this.text?.finish();
    this.setMode("draw");
    const s = derive(this.page);
    openPaperDialog({
      prefs: this.prefs,
      savePrefs: () => this.env.savePrefs(),
      size: () => ({ w: s.w, h: s.h }),
      paper: () => this.doc.paper,
      setPaper: (v) => { this.doc = { ...this.doc, paper: v }; this.syncPaper(); this.draw(); this.saver.markDirty(); this.stripSoon(); },
      resize: (w, h, m) => { this.act({ type: "resize", w, h, m }); toast(t("paperResized", { w, h })); },
    });
  }

  /** The paper button shows the paper colour and this page's size. */
  private syncPaper(): void {
    const dot = this.paperBtn.querySelector<HTMLElement>(".paper-dot");
    if (dot) { dot.classList.toggle("pdot-none", this.doc.paper === "none"); dot.style.background = this.doc.paper === "none" ? "" : paperFill(this.doc.paper); }
  }

  /** Leave whatever tool is half done before the page under it changes. */
  private settle(): void {
    this.text?.finish();
    this.setMode("draw");
    this.live = null;
  }

  private openPage(i: number): void {
    if (i === this.doc.current || !this.doc.pages[i]) return;
    this.settle();
    this.openPageAfterChange(i);
  }

  private async addPage(): Promise<void> {
    this.settle();
    if (this.doc.pages.length >= LIMITS.pages) { toast(t("pageLimit", { n: LIMITS.pages })); return; }
    const s = derive(this.page);
    const size = await askNewPage({ w: s.w, h: s.h });
    if (!size || this.closing) return;
    const doc: WorkDoc = { ...this.doc, next: { ...this.doc.next }, layers: { ...this.doc.layers }, pages: [...this.doc.pages] };
    const layer = nextId(doc, "layer");
    doc.layers[layer] = { name: t("layerDefaultName", { n: 1 }), visible: true, opacity: 1 };
    doc.pages.splice(doc.current + 1, 0, newPage(nextId(doc, "page"), size.w, size.h, layer));
    this.doc = doc;
    this.openPageAfterChange(doc.current + 1);
  }

  /** A copy of this page as it looks now (its own layers; the copy starts with no undo history). */
  private duplicatePage(): void {
    this.settle();
    if (this.doc.pages.length >= LIMITS.pages) { toast(t("pageLimit", { n: LIMITS.pages })); return; }
    const s = derive(this.page);
    const doc: WorkDoc = { ...this.doc, next: { ...this.doc.next }, layers: { ...this.doc.layers }, pages: [...this.doc.pages] };
    const ids = new Map(s.order.map((id) => [id, nextId(doc, "layer")]));
    const layers: Page["base"]["layers"] = {};
    for (const [old, id] of ids) { layers[id] = [...(s.layers[old] ?? [])]; doc.layers[id] = { ...(doc.layers[old] ?? { name: id, visible: true, opacity: 1 }) }; }
    const order = s.order.map((id) => ids.get(id) ?? id);
    const copy: Page = { id: nextId(doc, "page"), base: { w: s.w, h: s.h, order, layers }, actions: [], redo: [], active: ids.get(this.page.active) ?? order[order.length - 1] ?? "" };
    doc.pages.splice(doc.current + 1, 0, copy);
    this.doc = doc;
    this.openPageAfterChange(doc.current + 1);
  }

  private removePage(): void {
    if (this.doc.pages.length < 2) return;
    this.settle();
    const pages = this.doc.pages.filter((_, i) => i !== this.doc.current);
    this.doc = { ...this.doc, pages, current: Math.min(this.doc.current, pages.length - 1) };
    this.openPageAfterChange(this.doc.current);
  }

  private openPageAfterChange(i: number): void {
    this.sel = null;
    this.doc = { ...this.doc, current: i };
    this.view = IDENTITY;
    this.layout();
    this.panel.update();
    this.strip.update();
    this.saver.markDirty();
  }

  private select(id: LayerId): void {
    if (id === this.page.active) return;
    const moving = this.mode === "move";
    if (moving) this.setMode("draw");
    this.setPage({ ...this.page, active: id });
    this.panel.update();
    this.saver.markDirty();
    if (moving) this.setMode("move");
  }

  /** A new layer filled with white above the active one (its colour can be changed or removed), or a copy of `copyOf` above it. */
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
    this.setPage({ ...commit(this.page, { type: "add", id, index: at, ...(copyOf ? { copyOf } : { color: NEW_LAYER_COLOR }) }), active: id });
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

  /** Several chosen layers deleted in one undo step. */
  private removeLayers(ids: readonly LayerId[]): boolean {
    const r = deleteMany(derive(this.page), this.doc.layers, ids, this.page.active);
    if (!r) return false;
    this.setPage({ ...commit(this.page, r.action), active: r.active });
    this.refresh();
    toast(t("layerBulkDeleted", { n: ids.length }));
    return true;
  }

  /** Several chosen layers merged into the lowest of them in one undo step. */
  private mergeLayers(ids: readonly LayerId[]): boolean {
    const r = mergeMany(derive(this.page), this.doc.layers, ids);
    if (!r) return false;
    this.setPage({ ...commit(this.page, r.action), active: r.into });
    this.refresh();
    toast(t("layerBulkMerged", { n: ids.length }));
    return true;
  }

  /** Show, hide, lock or unlock several layers (settings, not undo steps). */
  private setManyProps(ids: readonly LayerId[], patch: Partial<LayerProps>): void {
    const layers = { ...this.doc.layers };
    for (const id of ids) { const cur = layers[id]; if (cur) layers[id] = { ...cur, ...patch }; }
    this.doc = { ...this.doc, layers };
    this.renderer.setProps(this.doc.layers);
    this.draw();
    this.panel.update();
    this.saver.markDirty();
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
    this.text?.finish();
    if (this.mode === "move") this.setMode("draw");
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
    const newImages = new Map(this.pendingImages);
    this.meta = await this.store.saveWork(this.meta.id, { doc: this.doc, now, newImages, ...(thumb ? { thumb } : {}) });
    for (const id of newImages.keys()) this.pendingImages.delete(id);
    // spec: ask the browser to keep our data after the first successful save
    if (!this.askedPersist) { this.askedPersist = true; void requestPersistence(); }
  }

  private showStatus(s: SaveStatus, err?: unknown): void {
    const quota = s === "error" && err instanceof StorageError && err.kind === "quota";
    this.pill.textContent = quota ? t("saveQuota") : t(s === "saved" ? "saveSaved" : s === "saving" ? "saveSaving" : s === "dirty" ? "saveDirty" : "saveError");
    this.pill.dataset.state = s;
    if (s === "error") console.error(err);
  }

  /**
   * The back button, before it closes the work: close the open menu, or leave the text, move or
   * select tool. False when there was nothing to step back from.
   */
  back(): boolean {
    if (this.toolbar.menuOpen) { this.toolbar.closeMenu(); return true; }
    if (this.panel.closeOpen()) return true;
    if (this.sel) { this.setSel(null); return true; }
    if (this.mode !== "draw") { this.setMode("draw"); return true; }
    return false;
  }

  /** Back to the gallery: save, keep a fresh picture, fold the undo history, release the work. */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.live = null;
    this.text?.finish();
    this.closeFrame();
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
    clearTimeout(this.stripTimer);
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

/** Pictures are kept at most this many pixels (bigger ones are made smaller on import), like the paper. */
const MAX_PICTURE_AREA = 16e6;

/**
 * Read a picture file safely: decoded by the browser (SVG drawn to pixels first, never inserted as
 * markup), made smaller when it is far bigger than the paper, and saved again as WebP so nothing but
 * pixels is kept (no hidden metadata).
 */
async function decodePicture(file: File, paperW: number, paperH: number): Promise<{ blob: Blob; bmp: ImageBitmap }> {
  let src: ImageBitmap | HTMLImageElement;
  if (file.type === "image/svg+xml") {
    const url = URL.createObjectURL(file);
    try {
      const im = new Image();
      im.src = url;
      await im.decode();
      src = im;
    } finally { URL.revokeObjectURL(url); }
  } else {
    src = await createImageBitmap(file);
  }
  const w0 = src.width || 1, h0 = src.height || 1;
  const k = Math.min(1, (Math.max(paperW, paperH) * 2) / Math.max(w0, h0), Math.sqrt(MAX_PICTURE_AREA / (w0 * h0)));
  const c = makeCanvas(Math.max(1, Math.round(w0 * k)), Math.max(1, Math.round(h0 * k)));
  const x = ctx2d(c);
  x.imageSmoothingQuality = "high";
  x.drawImage(src, 0, 0, c.width, c.height);
  if (src instanceof ImageBitmap) src.close();
  const blob = await c.convertToBlob({ type: "image/webp", quality: 0.92 });
  return { blob, bmp: await createImageBitmap(c) };
}
