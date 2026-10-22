/**
 * The browser may drop canvas memory (low memory, GPU reset, app in the background).
 * The page data is the truth, so the fix is always the same: redraw from the data.
 * Returns a function that stops watching.
 */
export function onCanvasRestored(canvas: HTMLCanvasElement | OffscreenCanvas, redraw: () => void): () => void {
  const handler = () => redraw();
  canvas.addEventListener("contextrestored", handler);
  return () => canvas.removeEventListener("contextrestored", handler);
}

/** Has this context lost its memory? (Older browsers without the check report false.) */
export function isLost(x: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D): boolean {
  const f = (x as { isContextLost?: () => boolean }).isContextLost;
  return typeof f === "function" ? f.call(x) : false;
}
