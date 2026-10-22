/**
 * The work model. Everything here is plain data: it is saved to IndexedDB, written into
 * .sketchbook backups and read back, so it must stay JSON-friendly (no classes, no Maps).
 *
 * A page keeps a starting state (base) plus a list of actions. The current state of the page
 * is always derived by replaying the actions over the base (see derive.ts). Undo removes the
 * last action; redo puts it back. Old actions are folded into the base so history stays bounded.
 */

export type LayerId = string;
export type ImageId = string;
export type PageId = string;
export type TextId = string;

/** [x, y, pressure 0–1, time ms] in paper pixels. */
export type Point = [number, number, number, number];

/**
 * Similarity transform used by move, scale and rotate: a point is turned by r (radians, around
 * the paper's top-left corner), scaled by s, then shifted:
 *   x' = s·(cos r·x − sin r·y) + dx,   y' = s·(sin r·x + cos r·y) + dy
 * r is optional (works saved before rotation existed have [s, dx, dy]).
 */
export type Mat = [s: number, dx: number, dy: number, r?: number];

/** A selection outline in paper pixels; `inv` selects everything outside it. */
export interface Mask {
  pts: [number, number][];
  inv: boolean;
}

export const BRUSHES = ["pen", "pencil", "ink", "nib", "marker", "spray", "eraser", "eraserall"] as const;
export type BrushId = (typeof BRUSHES)[number];

/** Erases only content. `eraserall` also cuts through the layer colour. */
export const isEraser = (b: BrushId): boolean => b === "eraser" || b === "eraserall";

// ---------- what a layer is made of (entries, drawn in order) ----------

export interface StrokeEntry {
  kind: "stroke";
  brush: BrushId;
  color: string;
  size: number;
  opacity: number;
  /** true when the points carry real pen pressure */
  pressure: boolean;
  /** fixes the randomness of textured brushes (pencil, spray) so a replay draws the same */
  seed: number;
  points: Point[];
  /** screen pixels per paper pixel when drawn; the ink brush thins with on-screen speed */
  vs?: number;
  mask?: Mask;
}

/** A picture placed on the layer. */
export interface ImageEntry {
  kind: "image";
  img: ImageId;
  x: number;
  y: number;
  w: number;
  h: number;
  opacity: number;
}

/** The whole layer replaced by new pixels (result of an image tool). */
export interface ReplaceEntry {
  kind: "replace";
  img: ImageId;
  w: number;
  h: number;
}

/** Everything inside the mask removed. */
export interface SelEraseEntry {
  kind: "selerase";
  mask: Mask;
}

/** Pixels inside the mask lifted and dropped at an offset. */
export interface SelMoveEntry {
  kind: "selmove";
  mask: Mask;
  dx: number;
  dy: number;
}

/** Many traced lines stored as one entry (photo → line drawing). */
export interface LineSetEntry {
  kind: "lineset";
  color: string;
  opacity: number;
  paths: LinePath[];
}
export interface LinePath {
  /** variable width: [x, y, w, x, y, w, …]; otherwise [x, y, x, y, …] drawn at `w` */
  pts: number[];
  v: boolean;
  w?: number;
  a: number;
}

/**
 * Earlier content kept together so later erasers inside it only affect it, and so it can be
 * moved (m) or redrawn sharply at a new paper size (src = the size it was drawn on).
 */
export interface GroupEntry {
  kind: "group";
  items: Entry[];
  opacity: number;
  m?: Mat;
  src?: [number, number];
}

/**
 * A layer's colour. Always the first entry of a layer when present. `holes` are the
 * "erase everything" strokes made since the colour was set; they are cut out of the colour.
 */
export interface BgEntry {
  kind: "bg";
  color: string;
  holes: Entry[];
}

export type TextAlign = "left" | "center" | "right";

/** Editable text. x, y = top-left of the unrotated box; rot in degrees. */
export interface TextData {
  tid: TextId;
  x: number;
  y: number;
  text: string;
  font: string;
  size: number;
  color: string;
  align: TextAlign;
  rot: number;
  /** box size at the last edit (paper pixels): the pivot when the layer is turned with the move tool */
  w?: number;
  h?: number;
}
export interface TextEntry extends TextData {
  kind: "text";
}

export type Entry =
  | StrokeEntry
  | ImageEntry
  | ReplaceEntry
  | SelEraseEntry
  | SelMoveEntry
  | LineSetEntry
  | GroupEntry
  | BgEntry
  | TextEntry;

/** Entries a "draw" action may add to a layer. */
export type DrawEntry = StrokeEntry | ImageEntry | ReplaceEntry | SelEraseEntry | SelMoveEntry | LineSetEntry;

// ---------- actions (one per undo step) ----------

export type Action =
  | { type: "add"; id: LayerId; index: number; copyOf?: LayerId; image?: ImageEntry; text?: TextData }
  | { type: "del"; id: LayerId }
  | { type: "move"; id: LayerId; to: number }
  | { type: "merge"; id: LayerId; into: LayerId; alpha: number }
  | { type: "draw"; layer: LayerId; entry: DrawEntry }
  | { type: "clear"; layer: LayerId }
  | { type: "xform"; layer: LayerId; m: Mat }
  | { type: "resize"; w: number; h: number; m: Mat }
  | { type: "bg"; layer: LayerId; color: string | null }
  | { type: "textset"; layer: LayerId; tid: TextId; text: TextData | null }
  | { type: "textflat"; layer: LayerId; tid: TextId; img: ImageId; w: number; h: number };

export type ActionType = Action["type"];

// ---------- pages and works ----------

export interface Page {
  id: PageId;
  /** paper size before the first action in `actions` */
  base: { w: number; h: number; order: LayerId[]; layers: Record<LayerId, Entry[]> };
  actions: Action[];
  redo: Action[];
  active: LayerId;
}

export interface LayerProps {
  name: string;
  visible: boolean;
  opacity: number;
  /** locked layers cannot be drawn on, erased, cleared, merged or deleted (not an undo step) */
  locked?: boolean;
}

/** "white" | "cream" | "none" (transparent) | "#rrggbb" */
export type PaperColor = string;

export const SCHEMA_VERSION = 1;

export interface WorkDoc {
  schema: typeof SCHEMA_VERSION;
  paper: PaperColor;
  current: number;
  pages: Page[];
  /** name, visibility and opacity per layer (not part of undo history) */
  layers: Record<LayerId, LayerProps>;
  /** counters for new ids, so ids never repeat inside a work */
  next: { layer: number; image: number; page: number };
}

/** The state of a page after replaying its actions. */
export interface PageState {
  w: number;
  h: number;
  order: LayerId[];
  layers: Record<LayerId, Entry[]>;
}
