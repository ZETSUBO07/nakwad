import { describe, expect, it } from "vitest";
import { fitScale, targetDpr } from "../../src/render/view";

describe("canvas resolution", () => {
  it("matches the screen when the paper fits", () => {
    // 2400×1600 paper on a 1524-wide view at 2× density
    const fit = fitScale(1524, 1016, 2400, 1600);
    expect(targetDpr(fit, 1, 2, 2400, 1600)).toBeCloseTo(fit * 2);
  });

  it("goes up to the paper's own pixels when zooming in, and no further", () => {
    expect(targetDpr(0.3, 2, 2, 2400, 1600)).toBe(1);
    expect(targetDpr(0.3, 16, 2, 2400, 1600)).toBe(1);
  });

  it("never exceeds 16 million pixels per layer", () => {
    const d = targetDpr(1, 4, 2, 6000, 2666);
    expect(6000 * 2666 * d * d).toBeLessThanOrEqual(16e6 + 1);
  });

  it("caps very high device ratios at 2", () => {
    expect(targetDpr(0.5, 1, 3, 1000, 1000)).toBe(1);
  });

  it("fits the paper inside the box with a margin", () => {
    expect(fitScale(1012, 512, 1000, 500)).toBe(1);
    expect(fitScale(5, 5, 1000, 1000)).toBe(0.01);
  });
});
