import type { Point } from "../core";

/**
 * Smooths a stroke by following the pen with a soft lag (spec: strength 0–100, low default).
 * Position and pressure are both smoothed. When the pen lifts, the line catches up to where
 * the pen actually was, so the end of the stroke is not cut short.
 */
export class Stabilizer {
  private readonly k: number;
  private s: [number, number, number] | null = null;
  private last: Point | null = null;

  constructor(strength: number) {
    const t = Math.min(100, Math.max(0, strength)) / 100;
    this.k = 1 - t * 0.93;
  }

  get active(): boolean { return this.k < 1; }

  /** First point of a stroke (returned unchanged). */
  start(p: Point): Point {
    this.s = [p[0], p[1], p[2]];
    this.last = p;
    return p;
  }

  /** Next raw point → the smoothed point to draw. */
  add(p: Point): Point {
    this.last = p;
    if (!this.s) return this.start(p);
    const s = this.s, k = this.k;
    s[0] += (p[0] - s[0]) * k;
    s[1] += (p[1] - s[1]) * k;
    s[2] += (p[2] - s[2]) * Math.min(1, k * 1.5);
    return [s[0], s[1], s[2], p[3]];
  }

  /**
   * Shown while drawing, not kept: the line carried from the smoothed position to where the pen
   * really is, so smoothing never makes the line trail behind the pen.
   */
  tail(steps = 4): Point[] {
    const s = this.s, r = this.last;
    if (!s || !r || !this.active) return [];
    return this.bridge(s, r, steps);
  }

  /** Points that carry the line from the smoothed position to where the pen lifted. */
  finish(steps = 4): Point[] {
    const s = this.s, r = this.last;
    this.s = null;
    if (!s || !r || !this.active) return [];
    return this.bridge(s, r, steps);
  }

  private bridge(s: [number, number, number], r: Point, steps: number): Point[] {
    const out: Point[] = [];
    for (let j = 1; j <= steps; j++) {
      const u = j / steps;
      out.push([s[0] + (r[0] - s[0]) * u, s[1] + (r[1] - s[1]) * u, s[2] + (r[2] - s[2]) * u, r[3] + j]);
    }
    return out;
  }
}
