import type { Point } from "../core";
import { GestureRecognizer, type FingerMode, type PointerKind, type Ptr } from "./gestures";
import { pinch, toPaper, zoomAt, type Frame, type Vec, type View } from "./view";

/**
 * Connects browser pointer events to the gesture rules and the view maths.
 * Everything that decides behaviour lives in gestures.ts and view.ts; this file only
 * translates events, which is why it is tested end to end rather than with unit tests.
 */

export interface InputHost {
  /** where the paper is right now */
  frame(): Frame;
  view(): View;
  setView(v: View, settled: boolean): void;
  /** a stroke starts at this paper point; `erase` when the pen's side button or eraser end is used */
  strokeStart(p: Point, kind: PointerKind, erase: boolean): void;
  /** new points of the stroke, plus guesses of where the pen goes next (drawn only until the next frame) */
  strokeMove(points: Point[], predicted: Point[]): void;
  strokeEnd(): void;
  strokeCancel(): void;
  undo(): void;
  redo(): void;
  fit(): void;
  /** the pen hovers above the screen at this screen point (null: it went away) */
  hover(at: Vec | null): void;
}

const kindOf = (t: string): PointerKind => (t === "pen" ? "pen" : t === "touch" ? "touch" : "mouse");

/**
 * Pointer Events give every pen the same signals, whatever its make: bit 2 of `buttons` is the
 * side (barrel) button, bit 32 the eraser end; `button` 5 is the eraser end touching.
 */
export const PEN_TIP = 1, PEN_SIDE = 2, PEN_ERASER = 32;
export function penErases(e: { pointerType: string; buttons: number; button: number }): boolean {
  return e.pointerType === "pen" && ((e.buttons & (PEN_SIDE | PEN_ERASER)) !== 0 || e.button === 5);
}
/** the side button pressed while the pen only hovers: some tablets report that as a press */
export function penHoverPress(e: { pointerType: string; buttons: number; pressure: number }): boolean {
  return e.pointerType === "pen" && (e.buttons & (PEN_TIP | PEN_ERASER)) === 0 && e.pressure === 0;
}

export interface InputController {
  setFingerMode(m: FingerMode): void;
  readonly fingerMode: FingerMode;
  detach(): void;
}

export function attachInput(el: HTMLElement, host: InputHost, fingerMode: FingerMode = "pen"): InputController {
  /** the event being handled, so the stroke callbacks can read its coalesced points */
  let current: PointerEvent | null = null;
  let pinchStart: View | null = null;

  const paperPoint = (e: PointerEvent): Point => {
    const [x, y] = toPaper(host.view(), host.frame(), [e.clientX, e.clientY]);
    // a pen reports 0 between samples on some devices; mouse and finger have no pressure
    const p = e.pointerType === "pen" ? (e.pressure > 0 ? e.pressure : 0.5) : 0.5;
    return [x, y, p, e.timeStamp];
  };

  const g = new GestureRecognizer({
    strokeStart: () => { if (current) host.strokeStart(paperPoint(current), kindOf(current.pointerType), penErases(current)); },
    strokeMove: () => {
      const e = current;
      if (!e) return;
      const list = e.getCoalescedEvents?.() ?? [];
      const predicted = e.getPredictedEvents?.() ?? [];
      host.strokeMove((list.length ? list : [e]).map(paperPoint), predicted.map(paperPoint));
    },
    strokeEnd: () => host.strokeEnd(),
    strokeCancel: () => host.strokeCancel(),
    pinchStart: () => { pinchStart = host.view(); },
    pinch: (a0, b0, a1, b1) => { if (pinchStart) host.setView(pinch(pinchStart, host.frame(), a0, b0, a1, b1), false); },
    pinchEnd: () => { pinchStart = null; host.setView(host.view(), true); },
    tap: (n) => (n === 2 ? host.undo() : host.redo()),
    fit: () => host.fit(),
  }, { fingerMode });

  const ptr = (e: PointerEvent): Ptr => ({ id: e.pointerId, kind: kindOf(e.pointerType), x: e.clientX, y: e.clientY, t: e.timeStamp, width: e.width, height: e.height });

  const onDown = (e: PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    if (penHoverPress(e)) return;
    try { el.setPointerCapture(e.pointerId); } catch { /* the pointer may already be gone */ }
    host.hover(null);
    current = e;
    g.down(ptr(e));
    current = null;
  };
  const onMove = (e: PointerEvent) => {
    if (e.pointerType === "pen" && e.buttons === 0) { host.hover([e.clientX, e.clientY]); return; }
    current = e;
    g.move(ptr(e));
    current = null;
  };
  const onUp = (e: PointerEvent) => { current = e; g.up(ptr(e), e.type === "pointercancel"); current = null; };
  // some tablets let go of the pointer without sending its lift: take that as the lift
  const onLost = (e: PointerEvent) => { if (g.drawingId === e.pointerId) { current = e; g.up(ptr(e)); current = null; } };
  const onLeave = (e: PointerEvent) => { if (e.pointerType === "pen") host.hover(null); };

  let wheelTimer = 0;
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    // mouse wheel and trackpad pinch (which arrives as wheel + ctrlKey) zoom around the pointer
    const step = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    host.setView(zoomAt(host.view(), host.frame(), Math.exp(-step * (e.ctrlKey ? 0.01 : 0.0015)), [e.clientX, e.clientY]), false);
    clearTimeout(wheelTimer);
    wheelTimer = window.setTimeout(() => host.setView(host.view(), true), 200);
  };
  const noMenu = (e: Event) => e.preventDefault();
  const lost = () => g.reset();

  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onUp);
  el.addEventListener("pointerleave", onLeave);
  el.addEventListener("lostpointercapture", onLost);
  el.addEventListener("wheel", onWheel, { passive: false });
  el.addEventListener("contextmenu", noMenu);
  window.addEventListener("blur", lost);

  return {
    get fingerMode() { return g.opts.fingerMode; },
    setFingerMode(m) { g.reset(); g.opts.fingerMode = m; },
    detach() {
      g.reset();
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("pointerleave", onLeave);
      el.removeEventListener("lostpointercapture", onLost);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("contextmenu", noMenu);
      window.removeEventListener("blur", lost);
    },
  };
}
