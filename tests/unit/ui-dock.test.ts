import { describe, expect, it } from "vitest";
import { MARGIN, SNAP_PX, defaultTb, drop, inset, isHorizontal, isTbState, menuAt, mirror, nextSize, place, type Area, type TbState } from "../../src/ui/dock";

const A: Area = { left: 0, top: 60, right: 1500, bottom: 1000 };
const W = 100, H = 600;

describe("floating toolbar placement", () => {
  it("starts docked on the side away from the pen hand, full size", () => {
    expect(defaultTb("left")).toMatchObject({ side: "right", size: "full" });
    expect(defaultTb("right")).toMatchObject({ side: "left", size: "full" });
  });

  it("cycles its size and mirrors with the hand", () => {
    expect([nextSize("full"), nextSize("compact"), nextSize("bubble")]).toEqual(["compact", "bubble", "full"]);
    expect(mirror(defaultTb("left")).side).toBe("left");
    expect(mirror(defaultTb("right")).side).toBe("right");
    const top: TbState = { ...defaultTb("left"), side: "top" };
    expect(mirror(top)).toBe(top);
    expect(isHorizontal(top)).toBe(true);
    expect(isHorizontal(defaultTb("left"))).toBe(false);
  });

  it("docks against each edge, along it, never outside the area", () => {
    const right = place({ ...defaultTb("left"), along: 0 }, W, H, A);
    expect(right).toEqual({ x: 1500 - W - MARGIN, y: 60 + MARGIN });
    const leftBottom = place({ ...defaultTb("right"), along: 1 }, W, H, A);
    expect(leftBottom).toEqual({ x: MARGIN, y: 1000 - H - MARGIN });
    const top = place({ size: "full", side: "top", along: 0.5, x: 0, y: 0 }, 600, 100, A);
    expect(top).toEqual({ x: MARGIN + 0.5 * (1500 - 600 - 2 * MARGIN), y: 60 + MARGIN });
    const bottom = place({ size: "full", side: "bottom", along: 0, x: 0, y: 0 }, 600, 100, A);
    expect(bottom.y).toBe(1000 - 100 - MARGIN);
    const lost = place({ size: "full", side: "free", along: 0, x: 5000, y: -400 }, W, H, A);
    expect(lost).toEqual({ x: 1500 - W - MARGIN, y: 60 + MARGIN });
    // an area too small for the toolbar still gives a place inside it
    const tiny = place(defaultTb("left"), W, H, { left: 0, top: 0, right: 50, bottom: 50 });
    expect(tiny).toEqual({ x: MARGIN, y: MARGIN });
  });

  it("dropping near an edge docks there, elsewhere it floats", () => {
    const tb = defaultTb("left");
    const nearLeft = drop(tb, { x: 20, y: 60 + MARGIN + (1000 - 60 - H - 2 * MARGIN) / 2, w: W, h: H }, A);
    expect(nearLeft.side).toBe("left");
    expect(nearLeft.along).toBeCloseTo(0.5);
    const nearBottom = drop(tb, { x: 400, y: 1000 - 100 - 10, w: 600, h: 100 }, A);
    expect(nearBottom.side).toBe("bottom");
    const middle = drop(tb, { x: 700, y: 300, w: W, h: 200 }, A);
    expect(middle).toMatchObject({ side: "free", x: 700, y: 300 });
    expect(drop(tb, { x: 1500 - W - SNAP_PX + 1, y: 300, w: W, h: 200 }, A).side).toBe("right");
    // the toolbar fills the whole height: along is 0, not a division by zero
    expect(drop(tb, { x: 0, y: 60, w: W, h: 940 }, A).along).toBe(0);
    expect(drop(tb, { x: 0, y: 60, w: 1500, h: 50 }, A).along).toBe(0);
  });

  it("takes room from the paper only when docked and not a bubble", () => {
    expect(inset(defaultTb("left"), W, H)).toEqual({ left: 0, right: W + 2 * MARGIN, top: 0, bottom: 0 });
    expect(inset({ size: "full", side: "top", along: 0, x: 0, y: 0 }, 600, 90).top).toBe(90 + 2 * MARGIN);
    expect(inset({ ...defaultTb("left"), size: "bubble" }, W, H)).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
    expect(inset({ ...defaultTb("left"), side: "free" }, W, H).right).toBe(0);
  });

  it("menus open towards the middle", () => {
    const btn = { x: 1400, y: 120, w: 44, h: 44 };
    const fromRight = menuAt(btn, 400, 300, { x: 1392, y: 68, w: 100, h: 600 }, A);
    expect(fromRight.x).toBe(1392 - 400 - MARGIN);
    expect(fromRight.y).toBe(120);
    const fromLeft = menuAt({ ...btn, x: 20 }, 400, 300, { x: 8, y: 68, w: 100, h: 600 }, A);
    expect(fromLeft.x).toBe(8 + 100 + MARGIN);
    const fromTop = menuAt({ x: 300, y: 80, w: 44, h: 44 }, 400, 300, { x: 100, y: 68, w: 900, h: 70 }, A);
    expect(fromTop).toEqual({ x: 300 + 22 - 200, y: 68 + 70 + MARGIN });
    const fromBottom = menuAt({ x: 10, y: 940, w: 44, h: 44 }, 400, 300, { x: 0, y: 922, w: 900, h: 70 }, A);
    expect(fromBottom).toEqual({ x: MARGIN, y: 922 - 300 - MARGIN });
    // a tall menu near the bottom is pulled up to stay inside
    expect(menuAt({ ...btn, y: 900 }, 400, 500, { x: 1392, y: 68, w: 100, h: 900 }, A).y).toBe(1000 - 500 - MARGIN);
  });

  it("checks stored toolbar places", () => {
    expect(isTbState(defaultTb("left"))).toBe(true);
    for (const bad of [null, 3, {}, { ...defaultTb("left"), size: "x" }, { ...defaultTb("left"), along: 2 }, { ...defaultTb("left"), x: Number.NaN }]) expect(isTbState(bad)).toBe(false);
  });
});
