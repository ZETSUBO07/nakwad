/**
 * Where the paper sits on screen. The paper element is centred in the desk and drawn at
 * `fit` screen pixels per paper pixel; on top of that the user zooms (s), rotates (r, radians)
 * and pans (tx, ty screen pixels). Same order as the CSS transform:
 *   translate(tx, ty) rotate(r) scale(s), around the desk centre.
 */
export interface View {
  s: number;
  r: number;
  tx: number;
  ty: number;
}

export type Vec = [number, number];

export interface Frame {
  /** desk centre on screen */
  center: Vec;
  /** screen pixels per paper pixel at zoom 1 */
  fit: number;
  /** paper size in paper pixels */
  w: number;
  h: number;
}

/** Spec: zoom from 10% to 1600% of the paper's real size, so the limits depend on `fit`. */
export const ZOOM_MIN_REAL = 0.1;
export const ZOOM_MAX_REAL = 16;
/** Rotation snaps to 0°, 90°, 180°, 270° when within this many degrees. */
export const SNAP_DEG = 8;

export const IDENTITY: View = { s: 1, r: 0, tx: 0, ty: 0 };

/** Screen point → paper point. */
export function toPaper(v: View, f: Frame, p: Vec): Vec {
  const dx = p[0] - f.center[0] - v.tx, dy = p[1] - f.center[1] - v.ty;
  const c = Math.cos(-v.r), s = Math.sin(-v.r), k = v.s * f.fit;
  return [(dx * c - dy * s) / k + f.w / 2, (dx * s + dy * c) / k + f.h / 2];
}

/** Paper point → screen point. */
export function toScreen(v: View, f: Frame, p: Vec): Vec {
  const k = v.s * f.fit, x = (p[0] - f.w / 2) * k, y = (p[1] - f.h / 2) * k;
  const c = Math.cos(v.r), s = Math.sin(v.r);
  return [f.center[0] + v.tx + x * c - y * s, f.center[1] + v.ty + x * s + y * c];
}

/** Zoom limits in view units (relative to fit). */
export function zoomLimits(fit: number): [number, number] {
  return [ZOOM_MIN_REAL / fit, ZOOM_MAX_REAL / fit];
}

/** Keep `paperPoint` under `screenPoint` after changing zoom and rotation. */
function anchor(v: View, f: Frame, paperPoint: Vec, screenPoint: Vec): View {
  const placed = toScreen({ ...v, tx: 0, ty: 0 }, f, paperPoint);
  return { ...v, tx: screenPoint[0] - placed[0], ty: screenPoint[1] - placed[1] };
}

export function clampZoom(s: number, fit: number): number {
  const [lo, hi] = zoomLimits(fit);
  return Math.min(hi, Math.max(lo, s));
}

/** Nearest right angle when close enough, else unchanged. Result in (-π, π]. */
export function snapRotation(r: number, tolDeg = SNAP_DEG): number {
  const tau = Math.PI * 2;
  let a = ((r % tau) + tau) % tau;
  if (a > Math.PI) a -= tau;
  const q = Math.round(a / (Math.PI / 2)) * (Math.PI / 2);
  const out = Math.abs(a - q) <= (tolDeg * Math.PI) / 180 ? q : a;
  return out === -Math.PI ? Math.PI : out;
}

/**
 * Two-finger gesture: from where the fingers started (a0, b0) to where they are now (a1, b1).
 * Zooms by the change in distance, rotates by the change in angle, and keeps the paper point
 * that was under the fingers' midpoint under the new midpoint (so it also pans).
 */
export function pinch(start: View, f: Frame, a0: Vec, b0: Vec, a1: Vec, b1: Vec, snap = true): View {
  const d0 = Math.hypot(b0[0] - a0[0], b0[1] - a0[1]) || 1, d1 = Math.hypot(b1[0] - a1[0], b1[1] - a1[1]) || 1;
  const ang0 = Math.atan2(b0[1] - a0[1], b0[0] - a0[0]), ang1 = Math.atan2(b1[1] - a1[1], b1[0] - a1[0]);
  const m0: Vec = [(a0[0] + b0[0]) / 2, (a0[1] + b0[1]) / 2], m1: Vec = [(a1[0] + b1[0]) / 2, (a1[1] + b1[1]) / 2];
  const under = toPaper(start, f, m0);
  let r = start.r + (ang1 - ang0);
  if (snap) r = snapRotation(r);
  return anchor({ s: clampZoom(start.s * (d1 / d0), f.fit), r, tx: 0, ty: 0 }, f, under, m1);
}

/** Zoom by `factor` around a screen point (mouse wheel, zoom buttons). */
export function zoomAt(v: View, f: Frame, factor: number, at: Vec): View {
  const under = toPaper(v, f, at);
  return anchor({ ...v, s: clampZoom(v.s * factor, f.fit) }, f, under, at);
}

/** The zoom the user sees, as a percentage of the paper's real size. */
export const zoomPercent = (v: View, f: Frame): number => Math.round(v.s * f.fit * 100);
