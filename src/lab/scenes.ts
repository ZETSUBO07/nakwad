import { commit, derive, newPage, type Action, type BrushId, type LayerProps, type Page, type Point, type StrokeEntry } from "../core";
import { t } from "../i18n";
import { PageRenderer, fillPaper, measureText } from "../render";

/**
 * Fixed scenes drawn by the end-to-end tests. Each one renders a known page at 1 device pixel
 * per paper pixel onto the lab canvas, so tests can check pixels at known places.
 */

const W = 600, H = 400;
const INK = "#1d2230";

const line = (y: number, x0 = 60, x1 = 540, n = 40): Point[] =>
  Array.from({ length: n }, (_, i) => [x0 + ((x1 - x0) * i) / (n - 1), y, 0.5, i * 16] as Point);

const stroke = (brush: BrushId, y: number, size: number, extra: Partial<StrokeEntry> = {}): StrokeEntry => ({
  kind: "stroke", brush, color: brush === "marker" ? "#e4472b" : INK, size, opacity: 1, pressure: false, seed: 7, vs: 1, points: line(y), ...extra,
});

function build(actions: Action[], w = W, h = H): Page {
  let p = newPage("P1", w, h, "L1");
  for (const a of actions) p = commit(p, a);
  return p;
}

const props = (ids: string[]): Record<string, LayerProps> => Object.fromEntries(ids.map((id) => [id, { name: id, visible: true, opacity: 1 }]));

const SCENES: Record<string, () => { page: Page; paper: string }> = {
  /** one row per brush; the two erasers cut through a dark band on a layer with a colour */
  brushes: () => ({
    paper: "white",
    page: build([
      { type: "draw", layer: "L1", entry: stroke("pen", 30, 6) },
      { type: "draw", layer: "L1", entry: stroke("pencil", 70, 12) },
      { type: "draw", layer: "L1", entry: stroke("ink", 110, 16) },
      { type: "draw", layer: "L1", entry: stroke("nib", 150, 18) },
      { type: "draw", layer: "L1", entry: stroke("marker", 190, 24) },
      { type: "draw", layer: "L1", entry: stroke("spray", 230, 30) },
      // the eraser rows live on a coloured layer underneath, so the brush rows stay on top of it
      { type: "add", id: "L2", index: 0 },
      { type: "bg", layer: "L2", color: "#cfe3ff" },
      { type: "draw", layer: "L2", entry: stroke("pen", 290, 30, { points: line(290, 20, 580) }) },
      { type: "draw", layer: "L2", entry: stroke("pen", 350, 30, { points: line(350, 20, 580) }) },
      { type: "draw", layer: "L2", entry: stroke("eraser", 290, 40, { points: line(290, 250, 350, 8) }) },
      { type: "draw", layer: "L2", entry: stroke("eraserall", 350, 40, { points: line(350, 250, 350, 8) }) },
    ]),
  }),
  /** a moved layer, and strokes redrawn after the paper doubled in size */
  groups: () => ({
    paper: "white",
    page: build([
      { type: "draw", layer: "L1", entry: stroke("pen", 50, 4, { points: line(50, 50, 250) }) },
      { type: "resize", w: W, h: H, m: [2, 0, 0] },
      { type: "add", id: "L2", index: 1 },
      { type: "draw", layer: "L2", entry: stroke("pen", 300, 10, { points: line(300, 50, 150) }) },
      { type: "xform", layer: "L2", m: [1, 300, 0] },
    ], W / 2, H / 2),
  }),
  /** text in two fonts, left and rotated */
  text: () => ({
    paper: "white",
    page: build([
      { type: "add", id: "L2", index: 1, text: { tid: "T1", x: 40, y: 40, text: t("appName"), font: "Mali", size: 48, color: INK, align: "left", rot: 0 } },
      { type: "add", id: "L3", index: 2, text: { tid: "T2", x: 40, y: 220, text: t("appName"), font: "Anuphan", size: 48, color: "#e4472b", align: "left", rot: 0 } },
    ]),
  }),
  /** selection: erase a box, then move another box */
  selection: () => ({
    paper: "cream",
    page: build([
      { type: "draw", layer: "L1", entry: stroke("pen", 100, 40, { points: line(100, 50, 550) }) },
      { type: "draw", layer: "L1", entry: { kind: "selerase", mask: { pts: [[100, 60], [200, 60], [200, 140], [100, 140]], inv: false } } },
      { type: "draw", layer: "L1", entry: { kind: "selmove", mask: { pts: [[400, 60], [500, 60], [500, 140], [400, 140]], inv: false }, dx: 0, dy: 200 } },
    ]),
  }),
  /** transparent paper shows a checkerboard */
  transparent: () => ({ paper: "none", page: build([]) }),
};

export interface LabTestApi {
  scene(name: string): Promise<{ w: number; h: number; widths?: Record<string, number> }>;
  rgba(x: number, y: number): number[];
  /** count pixels in a box whose red, green and blue are all below `dark` */
  countDark(x: number, y: number, w: number, h: number, dark?: number): number;
  /** wipe the canvas, as if its memory was lost */
  wipe(): void;
}

export function exposeScenes(canvas: HTMLCanvasElement, out: CanvasRenderingContext2D, pauseLab: () => void, extra: object = {}): void {
  let current: { renderer: PageRenderer; paper: string } | null = null;
  const api: LabTestApi = {
    ...extra,
    async scene(name) {
      const make = SCENES[name];
      if (!make) throw new Error(`no scene ${name}`);
      pauseLab();
      await document.fonts.load('48px "Mali"', t("appName"));
      await document.fonts.load('48px "Anuphan"', t("appName"));
      const { page, paper } = make();
      const s = derive(page);
      const renderer = new PageRenderer({ image: () => undefined });
      renderer.setState(s, props(s.order), 1);
      canvas.width = renderer.width;
      canvas.height = renderer.height;
      canvas.style.width = `${renderer.width}px`;
      canvas.style.height = `${renderer.height}px`;
      renderer.composite(out, paper);
      current = { renderer, paper };
      const widths = name === "text" ? { Mali: measureText({ text: t("appName"), size: 48, font: "Mali" }).w, Anuphan: measureText({ text: t("appName"), size: 48, font: "Anuphan" }).w } : undefined;
      return { w: s.w, h: s.h, ...(widths ? { widths } : {}) };
    },
    rgba(x, y) {
      return [...out.getImageData(x, y, 1, 1).data];
    },
    countDark(x, y, w, h, dark = 100) {
      const d = out.getImageData(x, y, w, h).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if ((d[i] ?? 255) < dark && (d[i + 1] ?? 255) < dark && (d[i + 2] ?? 255) < dark) n++;
      return n;
    },
    wipe() {
      out.clearRect(0, 0, canvas.width, canvas.height);
      fillPaper(out, "white");
    },
  };
  // after lost canvas memory, a scene is drawn again from its data (the lab is paused meanwhile)
  canvas.addEventListener("contextrestored", () => { if (current) current.renderer.composite(out, current.paper); });
  (window as unknown as { nakwadLab: LabTestApi }).nakwadLab = api;
}
