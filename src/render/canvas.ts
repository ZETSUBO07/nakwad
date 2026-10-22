/** Canvas helpers that work on the page and in a worker (OffscreenCanvas everywhere). */

export type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

export function makeCanvas(w: number, h: number): OffscreenCanvas {
  return new OffscreenCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
}

export function ctx2d(c: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const x = c.getContext("2d");
  if (!x) throw new Error("2D canvas is not available");
  return x;
}

/** Clear a whole canvas, whatever transform its context has. */
export function clearAll(x: Ctx): void {
  x.save();
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.globalAlpha = 1;
  x.globalCompositeOperation = "source-over";
  x.clearRect(0, 0, x.canvas.width, x.canvas.height);
  x.restore();
}

/** Copy `src` onto `x` 1:1 in device pixels. */
export function blit(x: Ctx, src: CanvasImageSource, alpha = 1, op: GlobalCompositeOperation = "source-over"): void {
  x.save();
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.globalAlpha = alpha;
  x.globalCompositeOperation = op;
  x.drawImage(src, 0, 0);
  x.restore();
}
