import type { Vec } from "./view";

/**
 * Decides what each pointer does: draw, move the paper, undo/redo taps, or nothing (palm).
 * Pure logic, fed plain events, so every rule is tested without a browser.
 *
 * Rules (spec "การใช้งานบนแท็บเล็ต"):
 * - pen and mouse draw; touch draws only in "fingers can draw" mode, with one finger
 * - two fingers move, zoom and rotate the paper; tap with two = undo, three = redo;
 *   a quick pinch-in fits the paper to the screen
 * - while the pen is down, and for a short moment after, touches are ignored (resting hand)
 * - very large contacts are palms and are ignored
 */

export type PointerKind = "pen" | "touch" | "mouse";
export type FingerMode = "pen" | "draw";

export interface Ptr {
  id: number;
  kind: PointerKind;
  x: number;
  y: number;
  /** event time, ms */
  t: number;
  /** contact size in CSS pixels (touch) */
  width?: number;
  height?: number;
}

export interface GestureHandlers {
  strokeStart(p: Ptr): void;
  strokeMove(p: Ptr): void;
  strokeEnd(p: Ptr): void;
  /** the stroke turned out to be the start of a two-finger gesture: drop it */
  strokeCancel(): void;
  pinchStart(): void;
  /** fingers started at a0, b0 and are now at a1, b1 (screen pixels) */
  pinch(a0: Vec, b0: Vec, a1: Vec, b1: Vec): void;
  pinchEnd(): void;
  tap(fingers: 2 | 3): void;
  fit(): void;
}

export interface GestureOptions {
  fingerMode: FingerMode;
  /** contacts wider or taller than this (CSS px) are palms */
  palmSize: number;
  /** touches this soon after the pen lifts are ignored */
  penGuardMs: number;
  tapMs: number;
  tapMovePx: number;
  /** a pinch that ends this quickly and shrinks to less than `quickPinchRatio` fits the paper */
  quickPinchMs: number;
  quickPinchRatio: number;
}

export const DEFAULT_GESTURES: GestureOptions = {
  fingerMode: "pen",
  palmSize: 42,
  penGuardMs: 300,
  tapMs: 250,
  tapMovePx: 12,
  quickPinchMs: 300,
  quickPinchRatio: 0.6,
};

interface Touch { start: Vec; now: Vec; moved: number }

export class GestureRecognizer {
  opts: GestureOptions;
  /** the pointer that is drawing, if any */
  private drawing: number | null = null;
  private drawingKind: PointerKind | null = null;
  /** where the drawing pointer was last seen */
  private last: Ptr | null = null;
  private penUpAt = -Infinity;
  private touches = new Map<number, Touch>();
  /** touches we decided to ignore until they lift */
  private ignored = new Set<number>();
  private session: { start: number; maxFingers: number; pinch: [number, number] | null; d0: number; moved: boolean } | null = null;

  constructor(private readonly h: GestureHandlers, opts: Partial<GestureOptions> = {}) {
    this.opts = { ...DEFAULT_GESTURES, ...opts };
  }

  get isDrawing(): boolean { return this.drawing !== null; }
  /** the pointer that is drawing, if any */
  get drawingId(): number | null { return this.drawing; }

  down(p: Ptr): void {
    if (p.kind !== "touch") {
      // the pen wins: any finger gesture stops, and is never taken as a tap
      if (this.session) this.endSession(p.t, true);
      for (const id of this.touches.keys()) this.ignored.add(id);
      this.touches.clear();
      if (this.drawing !== null) {
        if (this.drawingKind === "touch") {
          // a finger (or a resting palm) was drawing: the pen takes over and that line is dropped
          this.h.strokeCancel();
        } else if (this.last) {
          // a pen has one tip: a new contact means the lift of the last one never arrived
          this.h.strokeEnd(this.last);
        }
      }
      this.drawing = p.id;
      this.last = p;
      this.drawingKind = p.kind;
      this.h.strokeStart(p);
      return;
    }
    // the hand rests on the screen while the pen draws (a mouse has no hand on the screen)
    const penBusy = this.drawingKind === "pen" || p.t - this.penUpAt < this.opts.penGuardMs;
    const palm = (p.width ?? 0) > this.opts.palmSize || (p.height ?? 0) > this.opts.palmSize;
    if (penBusy || palm) { this.ignored.add(p.id); return; }
    this.touches.set(p.id, { start: [p.x, p.y], now: [p.x, p.y], moved: 0 });
    if (!this.session) this.session = { start: p.t, maxFingers: 0, pinch: null, d0: 0, moved: false };
    this.session.maxFingers = Math.max(this.session.maxFingers, this.touches.size);

    if (this.touches.size === 1 && this.opts.fingerMode === "draw" && this.drawing === null) {
      this.drawing = p.id;
      this.drawingKind = "touch";
      this.last = p;
      this.h.strokeStart(p);
      return;
    }
    if (this.touches.size === 2) {
      if (this.drawing !== null && this.drawingKind === "touch") { this.drawing = null; this.drawingKind = null; this.h.strokeCancel(); }
      this.beginPinch();
    }
  }

  private beginPinch(): void {
    const s = this.session;
    if (!s || s.pinch) return;
    const [a, b] = [...this.touches.entries()];
    if (!a || !b) return;
    // restart from where the fingers are now, so the paper does not jump
    for (const t of this.touches.values()) t.start = [...t.now];
    s.pinch = [a[0], b[0]];
    s.d0 = Math.hypot(b[1].now[0] - a[1].now[0], b[1].now[1] - a[1].now[1]) || 1;
    this.h.pinchStart();
  }

  move(p: Ptr): void {
    if (this.drawing === p.id) { this.last = p; this.h.strokeMove(p); return; }
    const t = this.touches.get(p.id);
    if (!t) return;
    t.moved = Math.max(t.moved, Math.hypot(p.x - t.start[0], p.y - t.start[1]));
    t.now = [p.x, p.y];
    const s = this.session;
    if (!s) return;
    if (t.moved > this.opts.tapMovePx) s.moved = true;
    if (s.pinch) {
      const a = this.touches.get(s.pinch[0]), b = this.touches.get(s.pinch[1]);
      if (a && b) this.h.pinch(a.start, b.start, a.now, b.now);
    }
  }

  up(p: Ptr, cancelled = false): void {
    if (this.ignored.delete(p.id)) return;
    if (this.drawing === p.id) {
      const kind = this.drawingKind;
      this.drawing = null;
      this.drawingKind = null;
      this.last = null;
      if (kind === "pen") this.penUpAt = p.t;
      if (cancelled) this.h.strokeCancel(); else this.h.strokeEnd(p);
      if (kind !== "touch") return;
    }
    if (!this.touches.has(p.id)) return;
    const s = this.session;
    if (s?.pinch && s.pinch.includes(p.id)) {
      // quick pinch-in check uses the distance at the moment one finger lifts
      const a = this.touches.get(s.pinch[0]), b = this.touches.get(s.pinch[1]);
      const d1 = a && b ? Math.hypot(b.now[0] - a.now[0], b.now[1] - a.now[1]) : s.d0;
      this.h.pinchEnd();
      s.pinch = null;
      if (!cancelled && p.t - s.start <= this.opts.quickPinchMs && d1 / s.d0 < this.opts.quickPinchRatio) { this.touches.delete(p.id); this.fitAfter(); return; }
    }
    this.touches.delete(p.id);
    if (this.touches.size === 0) this.endSession(p.t, cancelled);
  }

  private fitPending = false;
  private fitAfter(): void {
    this.fitPending = true;
    if (this.session) this.session.moved = true; // a pinch is never a tap
    if (this.touches.size === 0) this.endSession(0, false);
  }

  private endSession(t: number, cancelled: boolean): void {
    const s = this.session;
    this.session = null;
    if (s?.pinch) this.h.pinchEnd();
    if (this.fitPending) { this.fitPending = false; this.h.fit(); return; }
    if (!s || cancelled || s.moved) return;
    if (t - s.start > this.opts.tapMs) return;
    if (s.maxFingers === 2 || s.maxFingers === 3) this.h.tap(s.maxFingers);
  }

  /** Forget everything (window lost focus, app hidden). */
  reset(): void {
    if (this.drawing !== null) this.h.strokeCancel();
    if (this.session?.pinch) this.h.pinchEnd();
    this.drawing = null;
    this.drawingKind = null;
    this.last = null;
    this.touches.clear();
    this.ignored.clear();
    this.session = null;
    this.fitPending = false;
  }
}
