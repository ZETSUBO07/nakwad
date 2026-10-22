import { BRUSHES, canRedo, canUndo, commit, derive, drawBlock, fontsInUse, invert, layersFor, mul, nextId, redo, replaceLast, undo, validActive, type Action, type ImageEntry, type LayerId, type LayerProps, type Mat, type Page, type PageState, type Point, type StrokeEntry, type TextData, type WorkDoc } from "../core";
import { t } from "../i18n";
import { IDENTITY, Stabilizer, attachInput, toScreen, zoomPercent, type Frame, type InputController, type View } from "../input";
import { PageRenderer, drawText, fitScale, hitText, makeCanvas, ctx2d, measureText, onCanvasRestored, targetDpr } from "../render";
import { AutoSaver, StorageError, acquireWorkLock, requestPersistence, type SaveStatus, type Store, type WorkMeta } from "../storage";
import type { Area } from "./dock";
import { button, h } from "./dom";
import { ensureFont, ensureFonts, loadImportedFonts } from "./fonts";
import { LayersPanel } from "./layers";
import { TextSession, type TextTarget } from "./textTool";
import { TransformFrame } from "./transform";
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
  private mode: "draw" | "text" | "move" = "draw";
  /** the move / scale / turn frame: its layer, what has been kept so far, and the drag being shown */
  private frameBox: { frame: TransformFrame; layer: LayerId; kept: Mat | null; live: Mat | null } | null = null;
  private readonly fileIn: HTMLInputElement;
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
      toolChanged: () => { this.ring.hidden = true; if (this.text?.open) this.text.setColor(this.prefs.color); },
      toggleText: () => this.setMode(this.mode === "text" ? "draw" : "text"),
      textMode: () => this.mode === "text",
      toggleMove: () => this.setMode(this.mode === "move" ? "draw" : "move"),
      moveMode: () => this.mode === "move",
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
    const bar = h("header", { class: "ebar" }, back, h("h1", { class: "work-name", text: meta.name }), this.pill, h("span", { class: "spacer" }), this.layersBtn, settings);
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
    void this.loadFonts();
  }

  private readonly onKey = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest("dialog, textarea") || (target instanceof HTMLInputElement && target.type !== "range")) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      if (k === "z") { e.preventDefault(); this.history(e.shiftKey ? redo : undo); }
      else if (k === "y") { e.preventDefault(); this.history(redo); }
      return;
    }
    if (e.altKey || e.metaKey) return;
    // 1–8 pick a brush (7 and 8 are the two erasers), [ and ] change the size
    if (/^[1-8]$/.test(k)) { const b = BRUSHES[Number(k) - 1]; if (b) { this.setMode("draw"); this.toolbar.setBrush(b); } }
    else if (k === "t") this.setMode(this.mode === "text" ? "draw" : "text");
    else if (k === "v") this.setMode(this.mode === "move" ? "draw" : "move");
    else if ((k === "enter" || k === "escape") && this.mode === "move") this.setMode("draw");
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
    if (settled) { this.resolution(false); this.draw(); }
  }

  private draw(): void {
    const entry = this.live && this.predicted.length ? { ...this.live, points: [...this.live.points, ...this.predicted] } : this.live;
    const fb = this.frameBox;
    this.renderer.composite(this.out, this.doc.paper, entry ? { kind: "draw", layer: this.page.active, entry } : fb?.live ? { kind: "move", layer: fb.layer, m: fb.live } : undefined);
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
    if (this.mode === "text") { this.textTap(p); return; }
    if (this.mode === "move") return; // outside the frame: nothing to draw
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

  private setMode(m: "draw" | "text" | "move"): void {
    if (m === this.mode) return;
    this.text?.finish();
    this.closeFrame();
    this.mode = m;
    this.desk.classList.toggle("texting", m === "text");
    this.ring.hidden = true;
    if (m === "text") toast(t("textHint"));
    if (m === "move" && !this.openFrame()) this.mode = "draw";
    this.toolbar.sync();
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
    this.renderer.setState(this.shown(), this.doc.layers);
    this.draw();
    this.panel.update();
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
