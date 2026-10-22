import type { Point, StrokeEntry } from "../core";
import type { Ctx } from "./canvas";

/** Small seeded random generator: textured brushes draw the same grain on every replay. */
export function rng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pressure factor: 0.3–1.4 with a pen, 1 without. */
const pf = (s: StrokeEntry, p: number) => (s.pressure ? 0.3 + p * 1.1 : 1);

function walk(pts: Point[], step: number, fn: (x: number, y: number, p: number) => void): void {
  const first = pts[0];
  if (!first) return;
  fn(first[0], first[1], first[2]);
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as Point, b = pts[i] as Point;
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let t = step - carry;
    while (t <= d) {
      const u = t / d;
      fn(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u);
      t += step;
    }
    carry = d - (t - step);
  }
}

function smoothPath(c: Ctx, pts: Point[]): void {
  const p0 = pts[0] as Point;
  c.beginPath();
  c.moveTo(p0[0], p0[1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i] as Point, q = pts[i + 1] as Point;
    c.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
  }
  const l = pts[pts.length - 1] as Point;
  c.lineTo(l[0], l[1]);
}

function dot(c: Ctx, x: number, y: number, r: number): void {
  c.beginPath();
  c.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2);
  c.fill();
}

function pen(c: Ctx, s: StrokeEntry): void {
  const P = s.points, p0 = P[0] as Point;
  if (P.length < 2) return dot(c, p0[0], p0[1], (s.size * pf(s, p0[2])) / 2);
  if (!s.pressure) { smoothPath(c, P); c.lineWidth = s.size; c.stroke(); return; }
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1] as Point, b = P[i] as Point;
    c.lineWidth = s.size * pf(s, (a[2] + b[2]) / 2);
    c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke();
  }
}

function marker(c: Ctx, s: StrokeEntry): void {
  const P = s.points, p0 = P[0] as Point;
  if (P.length < 2) return dot(c, p0[0], p0[1], s.size / 2);
  smoothPath(c, P); c.lineWidth = s.size; c.stroke();
}

function pencil(c: Ctx, s: StrokeEntry): void {
  const r = rng(s.seed), w = Math.max(1, s.size * 0.5);
  walk(s.points, 0.8, (x, y, p) => {
    const rad = (w * pf(s, p)) / 2, n = Math.max(2, Math.round(rad * 1.6));
    for (let k = 0; k < n; k++) {
      const a = r() * Math.PI * 2, rr = Math.sqrt(r()) * rad;
      c.globalAlpha = 0.18 + r() * 0.5;
      c.fillRect(x + Math.cos(a) * rr - 0.55, y + Math.sin(a) * rr - 0.55, 1.1, 1.1);
    }
  });
  c.globalAlpha = 1;
}

function ink(c: Ctx, s: StrokeEntry): void {
  const P = s.points, p0 = P[0] as Point;
  if (P.length < 2) return dot(c, p0[0], p0[1], s.size * 0.35);
  let w = s.size * 0.3;
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1] as Point, b = P[i] as Point;
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    // speed measured on screen, not on paper, so zooming does not change the line
    const v = (d / Math.max(4, b[3] - a[3])) * (s.vs ?? 1);
    const target = s.size * Math.min(1.5, Math.max(0.2, 1.5 - v * 0.6)) * pf(s, b[2]);
    w = w * 0.75 + target * 0.25;
    const rem = P.length - 1 - i;
    c.lineWidth = rem < 6 ? (w * (rem + 1)) / 7 : w; // taper the tail like a lifted brush
    c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke();
  }
}

function nib(c: Ctx, s: StrokeEntry): void {
  const P = s.points, ang = -Math.PI / 4;
  const hx = (Math.cos(ang) * s.size) / 2, hy = (Math.sin(ang) * s.size) / 2;
  c.lineWidth = 1;
  const p0 = P[0] as Point;
  if (P.length < 2) { c.lineWidth = 1.5; c.beginPath(); c.moveTo(p0[0] - hx, p0[1] - hy); c.lineTo(p0[0] + hx, p0[1] + hy); c.stroke(); return; }
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1] as Point, b = P[i] as Point, ka = pf(s, a[2]), kb = pf(s, b[2]);
    c.beginPath();
    c.moveTo(a[0] + hx * ka, a[1] + hy * ka); c.lineTo(b[0] + hx * kb, b[1] + hy * kb);
    c.lineTo(b[0] - hx * kb, b[1] - hy * kb); c.lineTo(a[0] - hx * ka, a[1] - hy * ka);
    c.closePath(); c.fill(); c.stroke();
  }
}

function spray(c: Ctx, s: StrokeEntry): void {
  const r = rng(s.seed), R = s.size / 2;
  walk(s.points, Math.max(1.5, R * 0.3), (x, y, p) => {
    const rad = R * pf(s, p), n = Math.max(4, Math.round(rad * 0.9));
    for (let k = 0; k < n; k++) {
      const a = r() * Math.PI * 2, rr = rad * Math.sqrt(r()) * (0.4 + 0.6 * r());
      c.globalAlpha = 0.35 + r() * 0.5;
      c.fillRect(x + Math.cos(a) * rr, y + Math.sin(a) * rr, 1.3, 1.3);
    }
  });
  c.globalAlpha = 1;
}

const DRAW: Record<StrokeEntry["brush"], (c: Ctx, s: StrokeEntry) => void> = {
  pen, pencil, ink, nib, marker, spray, eraser: pen, eraserall: pen,
};

/**
 * Draw one stroke at full strength on `c` (cleared first). Erasers draw solid black: the caller
 * uses the result as a mask. Opacity and blending are applied when the stroke is composited.
 */
export function strokeOnto(c: Ctx, s: StrokeEntry): void {
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, c.canvas.width, c.canvas.height);
  c.restore();
  c.fillStyle = c.strokeStyle = s.brush === "eraser" || s.brush === "eraserall" ? "#000" : s.color;
  c.lineCap = c.lineJoin = "round";
  c.globalAlpha = 1;
  c.globalCompositeOperation = "source-over";
  DRAW[s.brush](c, s);
}
