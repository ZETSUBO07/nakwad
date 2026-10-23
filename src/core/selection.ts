import type { Mask } from "./types";

/**
 * Selection helpers (spec "โหมดเลือก"): pure maths on the outline, in paper pixels.
 * A mask with `inv` selects everything outside its outline.
 */

/** A rectangle from two corners, in any order. */
export function rectMask(x0: number, y0: number, x1: number, y1: number): Mask {
  const a = Math.min(x0, x1), b = Math.min(y0, y1), c = Math.max(x0, x1), d = Math.max(y0, y1);
  return { pts: [[a, b], [c, b], [c, d], [a, d]], inv: false };
}

/** The whole paper. */
export const allMask = (w: number, h: number): Mask => rectMask(0, 0, w, h);

export const invertMask = (m: Mask): Mask => ({ pts: m.pts, inv: !m.inv });

export const shiftMask = (m: Mask, dx: number, dy: number): Mask => ({ pts: m.pts.map(([x, y]) => [x + dx, y + dy]), inv: m.inv });

/** Is the point inside the outline (even-odd rule), ignoring `inv`? */
function insideOutline(pts: readonly [number, number][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i] as [number, number], [xj, yj] = pts[j] as [number, number];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Is the point selected? */
export const inMask = (m: Mask, x: number, y: number): boolean => insideOutline(m.pts, x, y) !== m.inv;

/** The box around what is selected, kept on the paper; null when nothing on the paper is selected. */
export function maskBounds(m: Mask, w: number, h: number): { x: number; y: number; w: number; h: number } | null {
  if (m.inv) return { x: 0, y: 0, w, h };
  const xs = m.pts.map((p) => p[0]), ys = m.pts.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs))), y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const x1 = Math.min(w, Math.ceil(Math.max(...xs))), y1 = Math.min(h, Math.ceil(Math.max(...ys)));
  return x1 - x0 >= 1 && y1 - y0 >= 1 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** A hand-drawn outline: drop points closer than `minGap` to the last kept one (fewer points, same shape). */
export function thinOutline(pts: readonly [number, number][], minGap = 2): [number, number][] {
  const out: [number, number][] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= minGap) out.push([p[0], p[1]]);
  }
  return out;
}

/** Big enough to be a selection (a tap is not). */
export function usableMask(m: Mask, minSide = 3): boolean {
  if (m.pts.length < 3) return false;
  const xs = m.pts.map((p) => p[0]), ys = m.pts.map((p) => p[1]);
  return Math.max(...xs) - Math.min(...xs) >= minSide && Math.max(...ys) - Math.min(...ys) >= minSide;
}
