import { describe, expect, it } from "vitest";
import { IDENTITY, clampZoom, pinch, snapRotation, toPaper, toScreen, zoomAt, zoomLimits, zoomPercent, type Frame, type Vec, type View } from "../../../src/input";

const F: Frame = { center: [500, 400], fit: 0.5, w: 1000, h: 600 };
const close = (a: Vec, b: Vec, eps = 1e-6) => { expect(a[0]).toBeCloseTo(b[0], 5); expect(a[1]).toBeCloseTo(b[1], 5); void eps; };

describe("view transform", () => {
  it("paper centre sits at the desk centre at rest", () => {
    close(toScreen(IDENTITY, F, [500, 300]), [500, 400]);
    close(toPaper(IDENTITY, F, [500, 400]), [500, 300]);
    close(toPaper(IDENTITY, F, [0, 250]), [-500, 0]);
  });

  it("toPaper undoes toScreen under zoom, rotation and pan", () => {
    const views: View[] = [{ s: 2, r: Math.PI / 2, tx: 30, ty: -40 }, { s: 0.7, r: -2.1, tx: -300, ty: 12 }, { s: 5, r: Math.PI, tx: 0, ty: 0 }];
    for (const v of views) for (const p of [[0, 0], [1000, 600], [123.4, 456.7]] as Vec[]) close(toPaper(v, F, toScreen(v, F, p)), p);
  });

  it("a 90° turn maps paper right to screen down", () => {
    const v = { s: 1, r: Math.PI / 2, tx: 0, ty: 0 };
    close(toScreen(v, F, [600, 300]), [500, 450]);
  });

  it("zoom stays between 10% and 1600% of the real size", () => {
    expect(zoomLimits(0.5)).toEqual([0.2, 32]);
    expect(clampZoom(100, 0.5)).toBe(32);
    expect(clampZoom(0.01, 0.5)).toBe(0.2);
    expect(clampZoom(3, 0.5)).toBe(3);
    expect(zoomPercent({ ...IDENTITY, s: 2 }, F)).toBe(100);
  });

  it("rotation snaps to right angles when close", () => {
    expect(snapRotation(0.05)).toBe(0);
    expect(snapRotation(Math.PI / 2 + 0.1)).toBeCloseTo(Math.PI / 2);
    expect(snapRotation(Math.PI + 0.05)).toBeCloseTo(Math.PI);
    expect(snapRotation(-Math.PI + 0.01)).toBeCloseTo(Math.PI);
    expect(snapRotation(0.5)).toBeCloseTo(0.5);
    expect(snapRotation(7 * Math.PI / 4)).toBeCloseTo(-Math.PI / 4);
  });

  it("pinch zooms by the distance change and keeps the point under the fingers", () => {
    const a0: Vec = [400, 400], b0: Vec = [600, 400];
    const under = toPaper(IDENTITY, F, [500, 400]);
    const v = pinch(IDENTITY, F, a0, b0, [300, 450], [700, 450]);
    expect(v.s).toBeCloseTo(2);
    expect(v.r).toBe(0);
    close(toScreen(v, F, under), [500, 450]);
  });

  it("pinch rotates with the fingers, snapping near right angles", () => {
    const v = pinch(IDENTITY, F, [400, 400], [600, 400], [500, 300], [500, 500]);
    expect(v.r).toBeCloseTo(Math.PI / 2);
    const free = pinch(IDENTITY, F, [400, 400], [600, 400], [400, 400], [600, 500], false);
    expect(free.r).toBeCloseTo(Math.atan2(100, 200));
    const snapped = pinch(IDENTITY, F, [400, 400], [600, 400], [400, 400], [600, 410]);
    expect(snapped.r).toBe(0);
  });

  it("pinch with fingers on the same spot does not break", () => {
    const v = pinch(IDENTITY, F, [500, 400], [500, 400], [500, 400], [500, 400]);
    expect(Number.isFinite(v.s) && Number.isFinite(v.tx)).toBe(true);
  });

  it("wheel zoom keeps the point under the pointer", () => {
    const at: Vec = [200, 100];
    const under = toPaper(IDENTITY, F, at);
    const v = zoomAt(IDENTITY, F, 3, at);
    expect(v.s).toBe(3);
    close(toScreen(v, F, under), at);
  });
});
