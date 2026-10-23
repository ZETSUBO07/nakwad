import { describe, expect, it } from "vitest";
import { allMask, inMask, invertMask, maskBounds, rectMask, shiftMask, thinOutline, usableMask, validateDoc, newWork, type Mask } from "../../../src/core";

describe("selection outlines", () => {
  const r = rectMask(50, 40, 10, 20);

  it("rectangles from any two corners", () => {
    expect(r.pts).toEqual([[10, 20], [50, 20], [50, 40], [10, 40]]);
    expect(allMask(100, 80).pts).toEqual([[0, 0], [100, 0], [100, 80], [0, 80]]);
  });

  it("what is inside, also inverted and moved", () => {
    expect(inMask(r, 30, 30)).toBe(true);
    expect(inMask(r, 5, 30)).toBe(false);
    expect(inMask(invertMask(r), 5, 30)).toBe(true);
    expect(inMask(invertMask(invertMask(r)), 30, 30)).toBe(true);
    const moved = shiftMask(r, 100, 0);
    expect(inMask(moved, 130, 30)).toBe(true);
    expect(inMask(moved, 30, 30)).toBe(false);
    // a hand-drawn triangle
    const tri: Mask = { pts: [[0, 0], [100, 0], [0, 100]], inv: false };
    expect(inMask(tri, 20, 20)).toBe(true);
    expect(inMask(tri, 80, 80)).toBe(false);
  });

  it("bounds kept on the paper", () => {
    expect(maskBounds(r, 200, 200)).toEqual({ x: 10, y: 20, w: 40, h: 20 });
    expect(maskBounds(rectMask(-20, -20, 30.4, 10.2), 200, 200)).toEqual({ x: 0, y: 0, w: 31, h: 11 });
    expect(maskBounds(rectMask(300, 300, 400, 400), 200, 200)).toBeNull();
    expect(maskBounds(invertMask(r), 200, 150)).toEqual({ x: 0, y: 0, w: 200, h: 150 });
  });

  it("hand-drawn outlines are thinned; taps are not selections", () => {
    expect(thinOutline([[0, 0], [0.5, 0], [1, 1], [3, 0], [3, 0.5], [6, 0]])).toEqual([[0, 0], [3, 0], [6, 0]]);
    expect(usableMask(r)).toBe(true);
    expect(usableMask(rectMask(0, 0, 2, 50))).toBe(false);
    expect(usableMask({ pts: [[0, 0], [10, 10]], inv: false })).toBe(false);
  });

  it("strokes limited to a selection are valid stored data", () => {
    const doc = newWork({ layerName: "1" });
    doc.pages[0]!.actions.push({ type: "draw", layer: "L1", entry: { kind: "stroke", brush: "pen", color: "#000000", size: 4, opacity: 1, pressure: false, seed: 1, points: [[1, 1, 0.5, 0]], mask: r } });
    doc.pages[0]!.actions.push({ type: "draw", layer: "L1", entry: { kind: "selmove", mask: r, dx: 5, dy: -5 } });
    expect(validateDoc(doc).ok).toBe(true);
  });
});
