import { describe, expect, it } from "vitest";
import { applyAction, applyMat, around, invert, moveText, mul, validateDoc, newWork, type Mat, type PageState, type TextEntry } from "../../../src/core";

const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 9));

describe("moves with rotation", () => {
  it("applies scale, turn and shift", () => {
    close(applyMat([2, 10, 20], 3, 4), [16, 28]);
    close(applyMat([1, 0, 0, Math.PI / 2], 1, 0), [0, 1]);
    close(applyMat([2, 5, 5, Math.PI], 1, 1), [3, 3]);
  });

  it("composes like applying one after the other, and inverts", () => {
    const A: Mat = [1.5, 7, -3, 0.4], B: Mat = [0.8, -2, 9, -1.1];
    for (const p of [[0, 0], [10, 3], [-4, 100]] as [number, number][]) {
      const [bx, by] = applyMat(B, ...p);
      close(applyMat(mul(A, B), ...p), applyMat(A, bx, by));
      close(applyMat(mul(invert(A), A), ...p), p);
    }
  });

  it("keeps old three-number moves exactly (no rotation stored when there is none)", () => {
    expect(mul([2, 1, 1], [3, 4, 5])).toEqual([6, 9, 11]);
    expect(invert([2, 4, 6])).toEqual([0.5, -2, -3]);
    expect(mul([1, 0, 0, 0.5], [1, 0, 0, -0.5])).toEqual([1, 0, 0]);
    // turns are kept within half a circle either way
    expect(mul([1, 0, 0, 3], [1, 0, 0, 3])[3]).toBeCloseTo(6 - Math.PI * 2);
  });

  it("turns and scales around a point, which stays put", () => {
    const m = around(100, 50, 2, Math.PI / 3);
    close(applyMat(m, 100, 50), [100, 50]);
    const d = around(100, 50, 1, 0, 30, -10);
    close(applyMat(d, 0, 0), [30, -10]);
  });
});

describe("text moved with its layer", () => {
  const t: TextEntry = { kind: "text", tid: "T1", x: 100, y: 100, text: "hi", font: "Anuphan", size: 40, color: "#000000", align: "left", rot: 10, w: 80, h: 56 };

  it("keeps its centre on the move and adds the turn to its own rotation", () => {
    const m = around(140, 128, 1, Math.PI / 2); // turn around the box centre
    const out = moveText(t, m);
    close([out.x, out.y, out.size, out.rot], [100, 100, 40, 100]);
    const big = moveText(t, around(140, 128, 2, 0));
    close([big.x, big.y, big.size, big.w!, big.h!], [60, 72, 80, 160, 112]);
    expect(moveText({ ...t, rot: 170 }, [1, 0, 0, Math.PI / 2]).rot).toBeCloseTo(-100);
  });

  it("older text without a saved box size moves as before", () => {
    const { w: _w, h: _h, ...old } = t;
    void _w; void _h;
    expect(moveText(old, [2, 5, 6])).toMatchObject({ x: 205, y: 206, size: 80, rot: 10 });
  });

  it("a moved layer of text stays text; other layers become one turned group", () => {
    const s: PageState = { w: 400, h: 300, order: ["A", "B"], layers: { A: [t], B: [{ kind: "stroke", brush: "pen", color: "#000000", size: 2, opacity: 1, pressure: false, seed: 1, points: [] }] } };
    applyAction(s, { type: "xform", layer: "A", m: [1, 0, 0, 0.5] });
    applyAction(s, { type: "xform", layer: "B", m: [1, 0, 0, 0.5] });
    applyAction(s, { type: "xform", layer: "B", m: [1, 3, 4, 0.25] });
    expect(s.layers.A?.[0]?.kind).toBe("text");
    const g = s.layers.B?.[0];
    expect(g?.kind === "group" && g.m?.[3]).toBeCloseTo(0.75);
  });
});

describe("stored moves and text boxes are checked", () => {
  it("accepts turns and box sizes, refuses nonsense", () => {
    const doc = newWork({ layerName: "1" });
    const page = doc.pages[0]!;
    page.actions.push({ type: "xform", layer: "L1", m: [1, 0, 0, 1.2] });
    expect(validateDoc(doc).ok).toBe(true);
    page.actions.push({ type: "xform", layer: "L1", m: [1, 0, 0, 99] });
    expect(validateDoc(doc).ok).toBe(false);
    page.actions.pop();
    page.actions.push({ type: "add", id: "L1", index: 1, text: { tid: "T", x: 0, y: 0, text: "a", font: "Mali", size: 20, color: "#000000", align: "left", rot: 0, w: -3 } });
    expect(validateDoc(doc).ok).toBe(false);
  });
});
