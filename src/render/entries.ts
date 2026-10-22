import type { BgEntry, Entry, LineSetEntry, Mask, StrokeEntry, TextData } from "../core";
import { strokeOnto } from "./brushes";
import { ctx2d, makeCanvas, type Ctx } from "./canvas";

/**
 * Everything needed to draw entries. Drawing happens in paper pixels on a context whose
 * transform is setTransform(dpr, 0, 0, dpr, 0, 0); compositing steps work in device pixels.
 */
export interface RenderEnv {
  /** device pixels per paper pixel */
  dpr: number;
  /** paper size in paper pixels */
  w: number;
  h: number;
  /** decoded picture for an image id, if it is loaded */
  image: (id: string) => CanvasImageSource | undefined;
  /** draw "erase everything" strokes as solid paint (to build the hole mask of a layer colour) */
  holeMode?: boolean;
}

// one scratch canvas per size, reused: a stroke is drawn here at full strength, then composited
const scratch = new Map<string, OffscreenCanvasRenderingContext2D>();
function scratchFor(w: number, h: number): OffscreenCanvasRenderingContext2D {
  const key = `${w}x${h}`;
  let x = scratch.get(key);
  if (!x) {
    if (scratch.size > 4) scratch.clear();
    x = ctx2d(makeCanvas(w, h));
    scratch.set(key, x);
  }
  return x;
}

function maskPath(m: Mask): Path2D {
  const p = new Path2D();
  if (m.inv) p.rect(-1e5, -1e5, 2e5, 2e5);
  const [first, ...rest] = m.pts;
  if (first) {
    p.moveTo(first[0], first[1]);
    for (const [x, y] of rest) p.lineTo(x, y);
    p.closePath();
  }
  return p;
}

/** Limit later drawing on `x` to the selection (call between save and restore). */
export function clipTo(x: Ctx, m: Mask, dpr: number): void {
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.clip(maskPath(m), m.inv ? "evenodd" : "nonzero");
  x.setTransform(1, 0, 0, 1, 0, 0);
}

function drawStroke(target: Ctx, s: StrokeEntry, env: RenderEnv): void {
  const { width, height } = target.canvas;
  const buf = scratchFor(width, height);
  buf.setTransform(env.dpr, 0, 0, env.dpr, 0, 0);
  strokeOnto(buf, s);
  target.save();
  target.setTransform(1, 0, 0, 1, 0, 0);
  if (s.mask) clipTo(target, s.mask, env.dpr);
  target.globalAlpha = s.opacity;
  const erase = s.brush === "eraser" || (s.brush === "eraserall" && !env.holeMode);
  target.globalCompositeOperation = erase ? "destination-out" : s.brush === "marker" ? "multiply" : "source-over";
  target.drawImage(buf.canvas, 0, 0);
  target.restore();
}

function drawLineSet(target: Ctx, e: LineSetEntry, env: RenderEnv): void {
  target.save();
  target.setTransform(env.dpr, 0, 0, env.dpr, 0, 0);
  target.strokeStyle = target.fillStyle = e.color;
  target.lineCap = target.lineJoin = "round";
  for (const p of e.paths) {
    const q = p.pts;
    target.globalAlpha = e.opacity * p.a;
    if (p.v) {
      if (q.length === 3) { target.beginPath(); target.arc(q[0] ?? 0, q[1] ?? 0, (q[2] ?? 1) / 2, 0, Math.PI * 2); target.fill(); continue; }
      for (let i = 0; i + 5 < q.length; i += 3) {
        target.lineWidth = ((q[i + 2] ?? 1) + (q[i + 5] ?? 1)) / 2;
        target.beginPath(); target.moveTo(q[i] ?? 0, q[i + 1] ?? 0); target.lineTo(q[i + 3] ?? 0, q[i + 4] ?? 0); target.stroke();
      }
    } else {
      target.lineWidth = p.w ?? 1;
      target.beginPath(); target.moveTo(q[0] ?? 0, q[1] ?? 0);
      for (let i = 2; i < q.length; i += 2) target.lineTo(q[i] ?? 0, q[i + 1] ?? 0);
      if (q.length === 2) target.lineTo((q[0] ?? 0) + 0.01, q[1] ?? 0);
      target.stroke();
    }
  }
  target.restore();
}

// ---------- text ----------

export const TEXT_LINE = 1.4;
const fallbackFonts = '"Anuphan", sans-serif';
export const fontCss = (t: Pick<TextData, "size" | "font">, scale = 1): string => `${t.size * scale}px "${t.font}", ${fallbackFonts}`;

let measurer: OffscreenCanvasRenderingContext2D | null = null;
/** Size of a text box in paper pixels, before rotation. */
export function measureText(t: Pick<TextData, "text" | "size" | "font">): { lines: string[]; lineHeight: number; w: number; h: number } {
  measurer ??= ctx2d(makeCanvas(4, 4));
  measurer.font = fontCss(t);
  const lines = t.text.split("\n"), lineHeight = t.size * TEXT_LINE;
  const w = Math.max(t.size * 0.3, ...lines.map((l) => measurer?.measureText(l).width ?? 0));
  return { lines, lineHeight, w, h: lines.length * lineHeight };
}

export function drawText(target: Ctx, t: TextData, env: RenderEnv): void {
  if (!t.text) return;
  const m = measureText(t);
  target.save();
  target.setTransform(env.dpr, 0, 0, env.dpr, 0, 0);
  target.font = fontCss(t);
  target.fillStyle = t.color;
  target.textBaseline = "middle";
  target.textAlign = t.align;
  target.globalAlpha = 1;
  target.globalCompositeOperation = "source-over";
  target.translate(t.x + m.w / 2, t.y + m.h / 2);
  target.rotate((t.rot * Math.PI) / 180);
  const ax = t.align === "center" ? 0 : t.align === "right" ? m.w / 2 : -m.w / 2;
  m.lines.forEach((line, i) => target.fillText(line, ax, -m.h / 2 + m.lineHeight * (i + 0.5)));
  target.restore();
}

/** Is a paper point inside a (rotated) text box? A margin makes small text easy to tap. */
export function hitText(t: TextData, px: number, py: number): boolean {
  const m = measureText(t), cx = t.x + m.w / 2, cy = t.y + m.h / 2, r = (-t.rot * Math.PI) / 180;
  const dx = (px - cx) * Math.cos(r) - (py - cy) * Math.sin(r);
  const dy = (px - cx) * Math.sin(r) + (py - cy) * Math.cos(r);
  const pad = Math.max(8, t.size * 0.15);
  return Math.abs(dx) <= m.w / 2 + pad && Math.abs(dy) <= m.h / 2 + pad;
}

// ---------- layer colour ----------

/** A layer colour with its "erase everything" holes cut out. */
export function renderBg(target: Ctx, e: BgEntry, env: RenderEnv): void {
  const { width, height } = target.canvas;
  target.save();
  target.setTransform(1, 0, 0, 1, 0, 0);
  target.globalAlpha = 1;
  target.globalCompositeOperation = "source-over";
  target.fillStyle = e.color;
  target.fillRect(0, 0, width, height);
  if (e.holes.length) {
    const mask = ctx2d(makeCanvas(width, height));
    mask.setTransform(env.dpr, 0, 0, env.dpr, 0, 0);
    const holeEnv = { ...env, holeMode: true };
    for (const h of e.holes) renderEntry(mask, h, holeEnv);
    target.globalCompositeOperation = "destination-out";
    target.drawImage(mask.canvas, 0, 0);
  }
  target.restore();
}

/** Cut one live "erase everything" stroke out of a layer colour canvas. */
export function cutHole(target: Ctx, s: StrokeEntry, env: RenderEnv): void {
  const mask = ctx2d(makeCanvas(target.canvas.width, target.canvas.height));
  mask.setTransform(env.dpr, 0, 0, env.dpr, 0, 0);
  renderEntry(mask, s, { ...env, holeMode: true });
  target.save();
  target.setTransform(1, 0, 0, 1, 0, 0);
  target.globalCompositeOperation = "destination-out";
  target.drawImage(mask.canvas, 0, 0);
  target.restore();
}

/**
 * A whole list of entries: a layer colour first goes underneath, the rest on top, so the stroke
 * eraser removes content and leaves the colour.
 */
export function renderList(target: Ctx, list: readonly Entry[], env: RenderEnv): void {
  const first = list[0];
  if (!first || first.kind !== "bg") { for (const e of list) renderEntry(target, e, env); return; }
  const content = ctx2d(makeCanvas(target.canvas.width, target.canvas.height));
  content.setTransform(env.dpr, 0, 0, env.dpr, 0, 0);
  for (const e of list.slice(1)) renderEntry(content, e, env);
  renderBg(target, first, env);
  target.save();
  target.setTransform(1, 0, 0, 1, 0, 0);
  target.drawImage(content.canvas, 0, 0);
  target.restore();
}

/** Draw one entry onto a layer canvas. */
export function renderEntry(target: Ctx, e: Entry, env: RenderEnv): void {
  switch (e.kind) {
    case "stroke":
      return drawStroke(target, e, env);
    case "lineset":
      return drawLineSet(target, e, env);
    case "text":
      return drawText(target, e, env);
    case "bg":
      return renderBg(target, e, env);
    case "image": {
      const im = env.image(e.img);
      if (!im) return;
      target.save();
      target.setTransform(env.dpr, 0, 0, env.dpr, 0, 0);
      target.globalAlpha = e.opacity;
      target.imageSmoothingQuality = "high";
      target.drawImage(im, e.x, e.y, e.w, e.h);
      target.restore();
      return;
    }
    case "replace": {
      const im = env.image(e.img);
      target.save();
      target.setTransform(1, 0, 0, 1, 0, 0);
      target.clearRect(0, 0, target.canvas.width, target.canvas.height);
      if (im) { target.setTransform(env.dpr, 0, 0, env.dpr, 0, 0); target.imageSmoothingQuality = "high"; target.drawImage(im, 0, 0, e.w, e.h); }
      target.restore();
      return;
    }
    case "selerase":
      target.save();
      target.setTransform(1, 0, 0, 1, 0, 0);
      clipTo(target, e.mask, env.dpr);
      target.clearRect(0, 0, target.canvas.width, target.canvas.height);
      target.restore();
      return;
    case "selmove": {
      const { width, height } = target.canvas;
      const lifted = ctx2d(makeCanvas(width, height));
      lifted.save(); clipTo(lifted, e.mask, env.dpr); lifted.drawImage(target.canvas, 0, 0); lifted.restore();
      target.save(); target.setTransform(1, 0, 0, 1, 0, 0); clipTo(target, e.mask, env.dpr); target.clearRect(0, 0, width, height); target.restore();
      target.save(); target.setTransform(1, 0, 0, 1, 0, 0); target.drawImage(lifted.canvas, Math.round(e.dx * env.dpr), Math.round(e.dy * env.dpr)); target.restore();
      return;
    }
    case "group": {
      const { width, height } = target.canvas;
      if (e.src && e.m) {
        // content from before a paper resize: redrawn at the new scale so strokes stay sharp
        const k = env.dpr * e.m[0];
        const tmp = ctx2d(makeCanvas(e.src[0] * k, e.src[1] * k));
        tmp.setTransform(k, 0, 0, k, 0, 0);
        renderList(tmp, e.items, { ...env, dpr: k, w: e.src[0], h: e.src[1] });
        target.save();
        target.setTransform(1, 0, 0, 1, 0, 0);
        target.globalAlpha = e.opacity;
        target.drawImage(tmp.canvas, Math.round(e.m[1] * env.dpr), Math.round(e.m[2] * env.dpr));
        target.restore();
        return;
      }
      const tmp = ctx2d(makeCanvas(width, height));
      tmp.setTransform(env.dpr, 0, 0, env.dpr, 0, 0);
      renderList(tmp, e.items, env);
      target.save();
      target.globalAlpha = e.opacity;
      if (e.m) {
        // a moved layer: drawn again with the move applied (scale and offset)
        target.setTransform(env.dpr * e.m[0], 0, 0, env.dpr * e.m[0], env.dpr * e.m[1], env.dpr * e.m[2]);
        target.drawImage(tmp.canvas, 0, 0, env.w, env.h);
      } else {
        target.setTransform(1, 0, 0, 1, 0, 0);
        target.drawImage(tmp.canvas, 0, 0);
      }
      target.restore();
      return;
    }
  }
}
