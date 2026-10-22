/**
 * How many device pixels the layer canvases get per paper pixel.
 * Sharp at the current zoom, never more than the paper's own pixels once zoomed in past 100%,
 * and capped so one layer never exceeds 16 million pixels.
 *
 * @param fit       screen pixels per paper pixel when the paper fits the screen
 * @param zoom      the user's zoom on top of that (1 = fit)
 * @param deviceRatio  window.devicePixelRatio (capped at 2)
 */
export function targetDpr(fit: number, zoom: number, deviceRatio: number, w: number, h: number): number {
  const dev = Math.min(Math.max(deviceRatio, 1), 2);
  const wanted = Math.max(fit * dev, Math.min(fit * zoom * dev, 1));
  return Math.min(wanted, Math.sqrt(16e6 / (w * h)));
}

/** Screen pixels per paper pixel so the paper fits inside a box with a margin. */
export function fitScale(boxW: number, boxH: number, w: number, h: number, margin = 12): number {
  return Math.max(0.01, Math.min((boxW - margin) / w, (boxH - margin) / h));
}
