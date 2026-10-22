/**
 * Where the floating toolbar sits. Pure maths, tested without a browser.
 * It docks to an edge (left/right = vertical, top/bottom = horizontal) at a fraction `along`
 * that edge, or floats at x, y. It can never leave the work area.
 */
export type TbSize = "full" | "compact" | "bubble";
export type TbSide = "left" | "right" | "top" | "bottom" | "free";
export interface TbState { size: TbSize; side: TbSide; along: number; x: number; y: number }
/** The area the toolbar lives in, in screen pixels. */
export interface Area { left: number; top: number; right: number; bottom: number }
export interface Rect { x: number; y: number; w: number; h: number }

export const MARGIN = 8;
/** dropped closer than this to an edge: dock to it */
export const SNAP_PX = 64;

const SIZES: readonly TbSize[] = ["full", "compact", "bubble"];
const SIDES: readonly TbSide[] = ["left", "right", "top", "bottom", "free"];
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function isTbState(v: unknown): v is TbState {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return SIZES.includes(o.size as TbSize) && SIDES.includes(o.side as TbSide)
    && [o.along, o.x, o.y].every((n) => typeof n === "number" && Number.isFinite(n)) && (o.along as number) >= 0 && (o.along as number) <= 1;
}

/** Spec: starts docked full size on the side away from the pen hand. */
export const defaultTb = (hand: "left" | "right"): TbState => ({ size: "full", side: hand === "left" ? "right" : "left", along: 0, x: 0, y: 0 });

/** Tapping the grip cycles full → compact → bubble → full. */
export const nextSize = (s: TbSize): TbSize => (s === "full" ? "compact" : s === "compact" ? "bubble" : "full");

export const isHorizontal = (tb: TbState): boolean => tb.side === "top" || tb.side === "bottom";

/** Switching hands mirrors a toolbar docked left or right. */
export function mirror(tb: TbState): TbState {
  if (tb.side === "left") return { ...tb, side: "right" };
  if (tb.side === "right") return { ...tb, side: "left" };
  return tb;
}

function range(w: number, h: number, a: Area) {
  return { minX: a.left + MARGIN, maxX: Math.max(a.left + MARGIN, a.right - w - MARGIN), minY: a.top + MARGIN, maxY: Math.max(a.top + MARGIN, a.bottom - h - MARGIN) };
}

/** Top-left corner of a toolbar of size w × h. */
export function place(tb: TbState, w: number, h: number, a: Area): { x: number; y: number } {
  const b = range(w, h, a);
  let x: number, y: number;
  if (tb.side === "left" || tb.side === "right") { x = tb.side === "right" ? b.maxX : b.minX; y = b.minY + tb.along * (b.maxY - b.minY); }
  else if (tb.side === "top" || tb.side === "bottom") { y = tb.side === "top" ? b.minY : b.maxY; x = b.minX + tb.along * (b.maxX - b.minX); }
  else { x = tb.x; y = tb.y; }
  return { x: clamp(x, b.minX, b.maxX), y: clamp(y, b.minY, b.maxY) };
}

/** Where a dragged toolbar ends up when let go at rect `r`: docked if near an edge, else floating. */
export function drop(tb: TbState, r: Rect, a: Area): TbState {
  const dist: Record<Exclude<TbSide, "free">, number> = { left: r.x - a.left, right: a.right - (r.x + r.w), top: r.y - a.top, bottom: a.bottom - (r.y + r.h) };
  const side = (Object.keys(dist) as (keyof typeof dist)[]).reduce((best, k) => (dist[k] < dist[best] ? k : best), "left");
  const b = range(r.w, r.h, a);
  if (dist[side] < SNAP_PX) {
    const along = side === "left" || side === "right"
      ? (b.maxY > b.minY ? (r.y - b.minY) / (b.maxY - b.minY) : 0)
      : (b.maxX > b.minX ? (r.x - b.minX) / (b.maxX - b.minX) : 0);
    return { ...tb, side, along: clamp(along, 0, 1) };
  }
  return { ...tb, side: "free", x: clamp(r.x, b.minX, b.maxX), y: clamp(r.y, b.minY, b.maxY) };
}

/** Space the docked toolbar takes from the paper on each side (a bubble takes none). */
export function inset(tb: TbState, w: number, h: number): { left: number; right: number; top: number; bottom: number } {
  const out = { left: 0, right: 0, top: 0, bottom: 0 };
  if (tb.size === "bubble" || tb.side === "free") return out;
  out[tb.side] = (tb.side === "left" || tb.side === "right" ? w : h) + MARGIN * 2;
  return out;
}

/**
 * Where a menu opened from the toolbar goes: always towards the middle of the work area
 * (spec), lined up with the button that opened it and kept inside the area.
 */
export function menuAt(button: Rect, menuW: number, menuH: number, tb: Rect, a: Area): { x: number; y: number } {
  const cx = (a.left + a.right) / 2, cy = (a.top + a.bottom) / 2;
  const tbcx = tb.x + tb.w / 2, tbcy = tb.y + tb.h / 2;
  const horizontalBar = tb.w > tb.h;
  let x: number, y: number;
  if (horizontalBar) {
    y = tbcy < cy ? tb.y + tb.h + MARGIN : tb.y - menuH - MARGIN;
    x = button.x + button.w / 2 - menuW / 2;
  } else {
    x = tbcx < cx ? tb.x + tb.w + MARGIN : tb.x - menuW - MARGIN;
    y = button.y;
  }
  return { x: clamp(x, a.left + MARGIN, Math.max(a.left + MARGIN, a.right - menuW - MARGIN)), y: clamp(y, a.top + MARGIN, Math.max(a.top + MARGIN, a.bottom - menuH - MARGIN)) };
}
