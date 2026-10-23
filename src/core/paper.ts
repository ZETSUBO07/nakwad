/** Paper sizes, colours and the per-layer memory budget. */

export const MIN_SIDE = 64;
export const MAX_SIDE = 6000;
/** 16 million pixels: the largest canvas the app will allocate per layer */
export const MAX_AREA = 16e6;
/** Starting memory budget for layer pixels, to be tuned on the tablet (milestone M8). */
export const LAYER_BUDGET_BYTES = 400e6;
/** Below this many layers the UI warns that the paper is very large. */
export const FEW_LAYERS = 8;

/** Preset ids; the UI shows their names from the text file. */
export const PAPER_SIZES = [
  { id: "landscape", w: 2400, h: 1600 },
  { id: "portrait", w: 1600, h: 2400 },
  { id: "square", w: 2048, h: 2048 },
  { id: "a4", w: 2480, h: 3508 },
  { id: "a5", w: 1748, h: 2480 },
  { id: "social", w: 1080, h: 1350 },
] as const;

export type PaperSizeId = (typeof PAPER_SIZES)[number]["id"];
export const DEFAULT_PAPER = PAPER_SIZES[0];

/** How many full layers fit in the budget at this paper size (4 bytes per pixel). */
export function layersFor(w: number, h: number, budget = LAYER_BUDGET_BYTES): number {
  return Math.floor(budget / (w * h * 4));
}

export type SizeProblem = "notInteger" | "tooSmall" | "tooLarge" | "areaTooLarge";

/** Why a paper size cannot be used, or null when it can. */
export function paperSizeProblem(w: number, h: number): SizeProblem | null {
  if (!Number.isInteger(w) || !Number.isInteger(h)) return "notInteger";
  if (w < MIN_SIDE || h < MIN_SIDE) return "tooSmall";
  if (w > MAX_SIDE || h > MAX_SIDE) return "tooLarge";
  if (w * h > MAX_AREA) return "areaTooLarge";
  return null;
}

export const PAPER_PRESET_COLORS = { white: "#ffffff", cream: "#fbf7ee" } as const;

const HEX = /^#[0-9a-f]{6}$/i;
export const isHexColor = (v: unknown): v is string => typeof v === "string" && HEX.test(v);

/** A paper colour value as stored: a preset name, "none" for transparent, or a hex colour. */
export function isPaperColor(v: unknown): boolean {
  return v === "none" || v === "white" || v === "cream" || isHexColor(v);
}

/** The colour to paint for a paper value; transparent paper paints white where a solid colour is needed. */
export function paperFill(v: string): string {
  if (v === "white" || v === "cream") return PAPER_PRESET_COLORS[v];
  return isHexColor(v) ? v.toLowerCase() : PAPER_PRESET_COLORS.white;
}
