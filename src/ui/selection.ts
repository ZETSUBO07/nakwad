import type { Mask } from "../core";
import { toScreen, type Frame, type View } from "../input";

const SVG = "http://www.w3.org/2000/svg";

/**
 * The selection outline ("marching ants") over the paper, following zoom and rotation.
 * An inverted selection also outlines the paper, so it is clear the outside is selected.
 */
export class SelectionOutline {
  readonly el: SVGSVGElement;
  private readonly light: SVGPathElement;
  private readonly dark: SVGPathElement;

  constructor() {
    this.el = document.createElementNS(SVG, "svg");
    this.el.classList.add("sel-outline");
    this.el.setAttribute("aria-hidden", "true");
    this.el.dataset.testid = "selection";
    this.light = document.createElementNS(SVG, "path");
    this.dark = document.createElementNS(SVG, "path");
    this.light.classList.add("ants-light");
    this.dark.classList.add("ants-dark");
    this.el.append(this.light, this.dark);
    this.el.style.display = "none";
  }

  /** Draw `mask` (paper pixels) on screen; null hides the outline. `closed` false for an outline still being drawn. */
  show(mask: Mask | null, frame: Frame, view: View, origin: { left: number; top: number }, closed = true): void {
    if (!mask || mask.pts.length < 2) { this.el.style.display = "none"; this.el.dataset.state = "none"; return; }
    const path = (pts: [number, number][], close: boolean) => pts.map((p, i) => {
      const [x, y] = toScreen(view, frame, p);
      return `${i ? "L" : "M"}${(x - origin.left).toFixed(1)} ${(y - origin.top).toFixed(1)}`;
    }).join(" ") + (close ? " Z" : "");
    let d = path(mask.pts, closed);
    if (mask.inv) d += " " + path([[0, 0], [frame.w, 0], [frame.w, frame.h], [0, frame.h]], true);
    this.light.setAttribute("d", d);
    this.dark.setAttribute("d", d);
    this.el.style.display = "";
    this.el.dataset.state = mask.inv ? "inverted" : "on";
  }
}
