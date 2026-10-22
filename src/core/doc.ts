import { DEFAULT_PAPER, paperSizeProblem } from "./paper";
import { SCHEMA_VERSION, type LayerId, type LayerProps, type Page, type PaperColor, type WorkDoc } from "./types";

/** Next id of a kind, advancing the work's counter ("L3", "I12", "P2"). */
export function nextId(doc: WorkDoc, kind: "layer" | "image" | "page"): string {
  doc.next[kind] += 1;
  const prefix = kind === "layer" ? "L" : kind === "image" ? "I" : "P";
  return prefix + doc.next[kind];
}

export function newPage(id: string, w: number, h: number, layer: LayerId): Page {
  return { id, base: { w, h, order: [layer], layers: { [layer]: [] } }, actions: [], redo: [], active: layer };
}

/**
 * A new work with one page and one empty layer.
 * `layerName` comes from the UI (translated text), so core stays free of display strings.
 */
export function newWork(opts: { w?: number; h?: number; paper?: PaperColor; layerName: string }): WorkDoc {
  const w = opts.w ?? DEFAULT_PAPER.w, h = opts.h ?? DEFAULT_PAPER.h;
  const problem = paperSizeProblem(w, h);
  if (problem) throw new RangeError(`paper size ${w}×${h}: ${problem}`);
  const doc: WorkDoc = { schema: SCHEMA_VERSION, paper: opts.paper ?? "white", current: 0, pages: [], layers: {}, next: { layer: 0, image: 0, page: 0 } };
  const layer = nextId(doc, "layer");
  doc.layers[layer] = defaultLayerProps(opts.layerName);
  doc.pages.push(newPage(nextId(doc, "page"), w, h, layer));
  return doc;
}

export const defaultLayerProps = (name: string): LayerProps => ({ name, visible: true, opacity: 1 });
