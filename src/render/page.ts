import { bgOf, type DrawEntry, type Entry, type LayerId, type LayerProps, type Mat, type PageState } from "../core";
import { blit, clearAll, ctx2d, makeCanvas, type Ctx } from "./canvas";
import { cutHole, renderBg, renderEntry, setMove, type RenderEnv } from "./entries";
import { fillPaper } from "./paper";

interface LayerCanvases {
  /** strokes, pictures and text */
  content: OffscreenCanvas;
  /** the layer colour with its holes (only for layers with a colour) */
  bg?: OffscreenCanvas;
  /** colour + content together, what the layer looks like */
  comp?: OffscreenCanvas;
}

/** A stroke being drawn, or a layer being dragged with the move tool. */
export type LivePreview =
  | { kind: "draw"; layer: LayerId; entry: DrawEntry }
  | { kind: "move"; layer: LayerId; m: Mat };

export interface RendererOptions {
  image: (id: string) => CanvasImageSource | undefined;
}

/**
 * Keeps one canvas per layer of the open page and composites them onto the screen.
 *
 * Speed: committing a stroke draws only that stroke onto its layer. While drawing, the layers
 * below and above the active one are pre-merged, so each frame draws three images.
 * Robustness: everything can be rebuilt from the page data at any time (`rebuild`), which is
 * what happens after the browser drops canvas memory.
 */
export class PageRenderer {
  private layers = new Map<LayerId, LayerCanvases>();
  private state: PageState = { w: 1, h: 1, order: [], layers: {} };
  private props: Record<LayerId, LayerProps> = {};
  private dpr = 1;
  private cache: { layer: LayerId; below: OffscreenCanvas; above: OffscreenCanvas } | null = null;
  private live2: OffscreenCanvasRenderingContext2D | null = null;
  private live: OffscreenCanvasRenderingContext2D | null = null;

  constructor(private readonly opts: RendererOptions) {}

  get width(): number { return Math.round(this.state.w * this.dpr); }
  get height(): number { return Math.round(this.state.h * this.dpr); }
  get resolution(): number { return this.dpr; }

  private env(): RenderEnv {
    return { dpr: this.dpr, w: this.state.w, h: this.state.h, image: this.opts.image };
  }

  /** Show a page state; redraws every layer. Call after undo/redo, layer changes, opening. */
  setState(state: PageState, props: Record<LayerId, LayerProps>, dpr = this.dpr): void {
    this.state = state;
    this.props = props;
    this.dpr = dpr;
    this.rebuild();
  }

  /** Layer names, visibility and opacity changed: no layer needs redrawing. */
  setProps(props: Record<LayerId, LayerProps>): void {
    this.props = props;
    this.cache = null;
  }

  /** Redraw every layer from the data (also used after the canvas memory was lost). */
  rebuild(): void {
    this.cache = null;
    this.live = this.live2 = null;
    for (const id of [...this.layers.keys()]) if (!this.state.order.includes(id)) this.layers.delete(id);
    for (const id of this.state.order) this.renderLayer(id);
  }

  private sized(c: OffscreenCanvas | undefined): OffscreenCanvas {
    if (c && c.width === this.width && c.height === this.height) { clearAll(ctx2d(c)); return c; }
    return makeCanvas(this.width, this.height);
  }

  private renderLayer(id: LayerId): void {
    const list = this.state.layers[id] ?? [];
    const prev = this.layers.get(id);
    const content = this.sized(prev?.content);
    const x = ctx2d(content);
    x.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const bg = bgOf(list);
    for (const e of bg ? list.slice(1) : list) renderEntry(x, e, this.env());
    const lc: LayerCanvases = { content };
    if (bg) {
      lc.bg = this.sized(prev?.bg);
      const bx = ctx2d(lc.bg);
      bx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      renderBg(bx, bg, this.env());
      lc.comp = this.sized(prev?.comp);
      this.joinComp(lc);
    }
    this.layers.set(id, lc);
  }

  private joinComp(lc: LayerCanvases): void {
    if (!lc.bg || !lc.comp) return;
    const c = ctx2d(lc.comp);
    clearAll(c);
    blit(c, lc.bg);
    blit(c, lc.content);
  }

  /**
   * A "draw" action was committed: draw just that entry onto its layer.
   * `state` is the page state after the action.
   */
  applyDraw(state: PageState, layer: LayerId, entry: DrawEntry): void {
    this.state = state;
    this.cache = null;
    const lc = this.layers.get(layer);
    if (!lc) { this.renderLayer(layer); return; }
    const x = ctx2d(lc.content);
    x.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    renderEntry(x, entry, this.env());
    if (lc.bg) {
      if (entry.kind === "stroke" && entry.brush === "eraserall") cutHole(ctx2d(lc.bg), entry, this.env());
      this.joinComp(lc);
    }
  }

  /**
   * The box around what is drawn on a layer (its colour left out), in paper pixels,
   * or null when the layer is empty. Read from the layer's pixels, so it fits what shows.
   */
  contentBounds(id: LayerId): { x: number; y: number; w: number; h: number } | null {
    const c = this.layers.get(id)?.content;
    if (!c) return null;
    const { width: W, height: H } = c, d = ctx2d(c).getImageData(0, 0, W, H).data;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) {
      const row = y * W * 4;
      for (let x = 0; x < W; x++) {
        if ((d[row + x * 4 + 3] ?? 0) > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y; }
      }
    }
    if (x1 < 0) return null;
    const k = this.dpr;
    return { x: x0 / k, y: y0 / k, w: (x1 - x0 + 1) / k, h: (y1 - y0 + 1) / k };
  }

  /** What a layer looks like (colour + content). */
  layerCanvas(id: LayerId): OffscreenCanvas | undefined {
    const lc = this.layers.get(id);
    return lc ? (lc.comp ?? lc.content) : undefined;
  }

  private visible(id: LayerId): LayerProps | null {
    const p = this.props[id];
    return p && p.visible ? p : null;
  }

  private merged(ids: LayerId[]): OffscreenCanvas {
    const c = makeCanvas(this.width, this.height), x = ctx2d(c);
    for (const id of ids) { const p = this.visible(id), src = this.layerCanvas(id); if (p && src) blit(x, src, p.opacity); }
    return c;
  }

  /** Pre-merge the layers below and above `layer` before a stroke starts. */
  prepareStroke(layer: LayerId): void {
    const i = this.state.order.indexOf(layer);
    this.cache = { layer, below: this.merged(this.state.order.slice(0, i)), above: this.merged(this.state.order.slice(i + 1)) };
  }

  private liveCtx(slot: "live" | "live2"): OffscreenCanvasRenderingContext2D {
    let x = this[slot];
    if (!x || x.canvas.width !== this.width || x.canvas.height !== this.height) { x = ctx2d(makeCanvas(this.width, this.height)); this[slot] = x; }
    clearAll(x);
    return x;
  }

  /** The layer with a live stroke on top, colour underneath (holes cut for "erase everything"). */
  private withLive(id: LayerId, entry: DrawEntry): OffscreenCanvas {
    const lc = this.layers.get(id);
    const x = this.liveCtx("live");
    if (lc) blit(x, lc.content);
    x.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    renderEntry(x, entry, this.env());
    if (!lc?.bg) return x.canvas;
    const y = this.liveCtx("live2");
    blit(y, lc.bg);
    if (entry.kind === "stroke" && entry.brush === "eraserall") cutHole(y, entry, this.env());
    blit(y, x.canvas);
    return y.canvas;
  }

  /**
   * Draw the page onto the screen canvas `out` (same size as the layers).
   * `paper` is the work's paper colour; `live` shows a stroke or a move that is not committed yet.
   */
  composite(out: Ctx, paper: string, live?: LivePreview): void {
    fillPaper(out, paper);
    if (live?.kind === "draw" && this.cache?.layer === live.layer) {
      const p = this.visible(live.layer);
      blit(out, this.cache.below);
      if (p) blit(out, this.withLive(live.layer, live.entry), p.opacity);
      blit(out, this.cache.above);
      return;
    }
    for (const id of this.state.order) {
      const p = this.visible(id);
      if (!p) continue;
      if (live?.layer === id && live.kind === "draw") { blit(out, this.withLive(id, live.entry), p.opacity); continue; }
      if (live?.layer === id && live.kind === "move") {
        const lc = this.layers.get(id);
        if (!lc) continue;
        if (lc.bg) blit(out, lc.bg, p.opacity);
        out.save();
        out.globalAlpha = p.opacity;
        setMove(out, live.m, this.dpr);
        out.drawImage(lc.content, 0, 0, this.state.w, this.state.h);
        out.restore();
        continue;
      }
      const src = this.layerCanvas(id);
      if (src) blit(out, src, p.opacity);
    }
  }

  /** A small picture of the page for the gallery, at most `max` pixels on its long side. */
  thumbnail(paper: string, max = 480): OffscreenCanvas {
    const k = Math.min(1, max / Math.max(this.state.w, this.state.h));
    const c = makeCanvas(this.state.w * k, this.state.h * k), x = ctx2d(c);
    fillPaper(x, paper, 6);
    x.imageSmoothingQuality = "high";
    for (const id of this.state.order) {
      const p = this.visible(id), src = this.layerCanvas(id);
      if (!p || !src) continue;
      x.globalAlpha = p.opacity;
      x.drawImage(src, 0, 0, c.width, c.height);
    }
    return c;
  }

  /** The page drawn on its own canvas, for thumbnails and export. Transparent paper stays transparent unless `paper` is given. */
  flatten(paper?: string): OffscreenCanvas {
    const c = makeCanvas(this.width, this.height), x = ctx2d(c);
    if (paper && paper !== "none") fillPaper(x, paper);
    for (const id of this.state.order) { const p = this.visible(id), src = this.layerCanvas(id); if (p && src) blit(x, src, p.opacity); }
    return c;
  }
}

/** Entries of a layer that are editable text, for tapping with the text tool. */
export const textEntries = (list: readonly Entry[]) => list.filter((e) => e.kind === "text");
