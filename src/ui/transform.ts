import { applyMat, around, mul, type Mat } from "../core";
import { t } from "../i18n";
import { toPaper, toScreen, type Frame, type Vec, type View } from "../input";
import { button, h } from "./dom";

export interface FrameHost {
  frame(): Frame;
  view(): View;
  /** the element the frame is drawn in (the work area) */
  container(): HTMLElement;
  /** while dragging: show the layer moved by `m` (from where it was when the frame opened) */
  preview(m: Mat): void;
  /** a drag ended: keep the layer moved by `m` (from where it was when the frame opened) */
  commit(m: Mat): void;
  done(): void;
}

type Grip = "move" | "rotate" | "nw" | "ne" | "se" | "sw";
const CORNERS: Exclude<Grip, "move" | "rotate">[] = ["nw", "ne", "se", "sw"];
/** turning snaps to right angles when this close (degrees) */
const SNAP_DEG = 5;
const MIN_SIDE_PX = 12;

/**
 * The frame around a layer's content (spec "กรอบปรับรูป"): drag inside to move, drag a corner to
 * scale keeping the proportions, drag the handle above the top edge to turn. Each drag is kept when
 * it ends; the whole time the frame is open counts as one undo step (the editor merges them).
 */
export class TransformFrame {
  private readonly el: HTMLElement;
  private readonly doneBtn: HTMLButtonElement;
  /** total move since the frame opened */
  private m: Mat = [1, 0, 0];
  private drag: { id: number; grip: Grip; start: Mat; p0: Vec; c: Vec; a0: number; d0: number } | null = null;

  constructor(private readonly host: FrameHost, private readonly box: { x: number; y: number; w: number; h: number }) {
    const grips = CORNERS.map((c) => h("span", { class: `tgrip corner ${c}`, data: { grip: c }, attrs: { "aria-hidden": "true" } }));
    const rot = h("span", { class: "tgrip rotate", data: { grip: "rotate" }, attrs: { title: t("frameRotate"), "aria-hidden": "true" } });
    this.doneBtn = button({ label: t("frameDone"), class: "primary frame-done", data: { action: "frame-done" }, onClick: () => host.done() });
    this.el = h("div", { class: "tframe", data: { testid: "transform-frame", grip: "move" }, attrs: { title: t("frameMove") } }, ...grips, rot, h("span", { class: "tstem" }), this.doneBtn);
    this.el.addEventListener("pointerdown", this.onDown);
    this.el.addEventListener("pointermove", this.onMove);
    this.el.addEventListener("pointerup", this.onUp);
    this.el.addEventListener("pointercancel", this.onUp);
    host.container().append(this.el);
    this.place();
  }

  /** the move so far */
  get move(): Mat { return this.m; }

  /** Where the box corners are now (paper pixels). */
  private corners(m: Mat = this.m): Vec[] {
    const b = this.box;
    return [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]].map(([x, y]) => applyMat(m, x as number, y as number));
  }

  private center(m: Mat = this.m): Vec { return applyMat(m, this.box.x + this.box.w / 2, this.box.y + this.box.h / 2); }

  /** Lay the frame over the content, following the move, zoom and rotation of the view. */
  place(): void {
    const f = this.host.frame(), v = this.host.view(), k = v.s * f.fit * this.m[0];
    const c = toScreen(v, f, this.center()), cr = this.host.container().getBoundingClientRect();
    const w = Math.max(MIN_SIDE_PX, this.box.w * k), hh = Math.max(MIN_SIDE_PX, this.box.h * k);
    this.el.style.width = `${w}px`;
    this.el.style.height = `${hh}px`;
    const angle = v.r + (this.m[3] ?? 0);
    this.el.style.transform = `translate(${c[0] - cr.left - w / 2}px, ${c[1] - cr.top - hh / 2}px) rotate(${angle}rad)`;
    this.el.dataset.turn = String(Math.round(((this.m[3] ?? 0) * 180) / Math.PI));
    // the button reads upright whatever the frame's angle
    this.doneBtn.style.transform = `translateX(-50%) rotate(${-angle}rad)`;
  }

  private paperAt(e: PointerEvent): Vec { return toPaper(this.host.view(), this.host.frame(), [e.clientX, e.clientY]); }

  private readonly onDown = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    this.el.setPointerCapture(e.pointerId);
    const grip = ((e.target as HTMLElement).dataset.grip ?? "move") as Grip;
    const p0 = this.paperAt(e), c = this.center();
    this.drag = { id: e.pointerId, grip, start: this.m, p0, c, a0: Math.atan2(p0[1] - c[1], p0[0] - c[0]), d0: Math.hypot(p0[0] - c[0], p0[1] - c[1]) || 1 };
    this.el.classList.add("dragging");
  };

  private readonly onMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    const p = this.paperAt(e);
    let step: Mat;
    if (d.grip === "move") step = [1, p[0] - d.p0[0], p[1] - d.p0[1]];
    else if (d.grip === "rotate") {
      const total = (d.start[3] ?? 0) + Math.atan2(p[1] - d.c[1], p[0] - d.c[0]) - d.a0;
      const q = Math.round(total / (Math.PI / 2)) * (Math.PI / 2);
      const snapped = Math.abs(total - q) <= (SNAP_DEG * Math.PI) / 180 ? q : total;
      step = around(d.c[0], d.c[1], 1, snapped - (d.start[3] ?? 0));
    } else {
      // a corner: scale around the opposite corner, keeping the proportions
      const i = CORNERS.indexOf(d.grip), anchor = this.corners(d.start)[(i + 2) % 4] as Vec;
      const from = Math.hypot(d.p0[0] - anchor[0], d.p0[1] - anchor[1]) || 1, to = Math.hypot(p[0] - anchor[0], p[1] - anchor[1]);
      const minK = (MIN_SIDE_PX / (this.host.view().s * this.host.frame().fit)) / Math.max(1e-6, Math.min(this.box.w, this.box.h) * d.start[0]);
      step = around(anchor[0], anchor[1], Math.max(minK, to / from), 0);
    }
    this.m = mul(step, d.start);
    this.place();
    this.host.preview(this.m);
  };

  private readonly onUp = (e: PointerEvent) => {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    this.drag = null;
    this.el.classList.remove("dragging");
    const moved = this.m !== d.start;
    if (moved) this.host.commit(this.m);
  };

  remove(): void { this.el.remove(); }
}
