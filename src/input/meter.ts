import type { PointerKind } from "./gestures";

/**
 * Measures strokes for the diagnostics page: how often the pen (or finger) sends a point, and how
 * smoothly the screen kept drawing while the stroke went on. Times are in milliseconds, from the
 * events' own time stamps, so the numbers say what the device did, not when we got round to it.
 */

export interface StrokeStats {
  kind: PointerKind;
  /** points the device sent (coalesced points included) */
  samples: number;
  /** from the first to the last point */
  ms: number;
  /** points per second; null when the stroke was too short to tell */
  rateHz: number | null;
  /** frames per second while drawing; null without enough frames */
  fps: number | null;
  /** the longest gap between two frames */
  worstFrameMs: number | null;
}

export interface MeterSummary {
  strokes: number;
  /** middle value of the strokes' point rates */
  rateHz: number | null;
  /** middle value of the strokes' frame rates */
  fps: number | null;
  /** the longest frame gap in any of them */
  worstFrameMs: number | null;
}

/** shorter strokes say little about a rate */
const MIN_MS = 100;
/** strokes kept for the summary */
export const METER_KEEP = 20;

export function median(v: readonly number[]): number | null {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b), m = s.length >> 1, mid = s[m] ?? 0;
  return s.length % 2 ? mid : ((s[m - 1] ?? 0) + mid) / 2;
}

/** Events per second from their time stamps; null when there are too few or too short. */
export function rate(times: readonly number[], minMs = MIN_MS): number | null {
  if (times.length < 3) return null;
  const ms = (times[times.length - 1] ?? 0) - (times[0] ?? 0);
  return ms >= minMs ? ((times.length - 1) * 1000) / ms : null;
}

export function worstGap(times: readonly number[]): number | null {
  let w: number | null = null;
  for (let i = 1; i < times.length; i++) w = Math.max(w ?? 0, (times[i] ?? 0) - (times[i - 1] ?? 0));
  return w;
}

export class StrokeMeter {
  private cur: { kind: PointerKind; points: number[]; frames: number[] } | null = null;
  private readonly kept: StrokeStats[] = [];

  get active(): boolean { return this.cur !== null; }

  start(kind: PointerKind, t: number): void {
    this.cur = { kind, points: [t], frames: [] };
  }

  /** time stamps of the points that arrived (the same time may come twice: counted once) */
  points(times: readonly number[]): void {
    const c = this.cur;
    if (!c) return;
    for (const t of times) if (t > (c.points[c.points.length - 1] ?? -Infinity)) c.points.push(t);
  }

  /** a screen frame went by (requestAnimationFrame time) */
  frame(t: number): void {
    this.cur?.frames.push(t);
  }

  end(): StrokeStats | null {
    const c = this.cur;
    this.cur = null;
    if (!c) return null;
    const s: StrokeStats = {
      kind: c.kind,
      samples: c.points.length,
      ms: (c.points[c.points.length - 1] ?? 0) - (c.points[0] ?? 0),
      rateHz: rate(c.points),
      fps: rate(c.frames),
      worstFrameMs: worstGap(c.frames),
    };
    this.kept.push(s);
    if (this.kept.length > METER_KEEP) this.kept.shift();
    return s;
  }

  cancel(): void { this.cur = null; }

  get recent(): readonly StrokeStats[] { return this.kept; }

  summary(kind: PointerKind): MeterSummary {
    const k = this.kept.filter((s) => s.kind === kind);
    const nums = (f: (s: StrokeStats) => number | null) => k.map(f).filter((x): x is number => x !== null);
    const worst = nums((s) => s.worstFrameMs);
    return { strokes: k.length, rateHz: median(nums((s) => s.rateHz)), fps: median(nums((s) => s.fps)), worstFrameMs: worst.length ? Math.max(...worst) : null };
  }
}
