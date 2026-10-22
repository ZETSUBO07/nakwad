import { paperFill } from "../core";
import type { Ctx } from "./canvas";

const CHECK_LIGHT = "#ffffff", CHECK_DARK = "#e4e6ec";

/** Fill the paper: its colour, or a light checkerboard for transparent paper. */
export function fillPaper(x: Ctx, paper: string, cell = 10): void {
  const { width, height } = x.canvas;
  x.save();
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.globalAlpha = 1;
  x.globalCompositeOperation = "source-over";
  if (paper === "none") {
    const c = Math.max(2, Math.round(cell));
    x.fillStyle = CHECK_LIGHT;
    x.fillRect(0, 0, width, height);
    x.fillStyle = CHECK_DARK;
    for (let y = 0; y < height; y += c) for (let col = ((y / c) % 2) * c; col < width; col += 2 * c) x.fillRect(col, y, c, c);
  } else {
    x.fillStyle = paperFill(paper);
    x.fillRect(0, 0, width, height);
  }
  x.restore();
}
