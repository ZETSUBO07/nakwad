import { describe, expect, it } from "vitest";
import { applyAction, dropTarget, drawBlock, layerMenuState, moveTarget, validateDoc, newWork, type LayerProps, type PageState } from "../../../src/core";

const state = (order: string[], layers: PageState["layers"] = {}): PageState => ({ w: 100, h: 100, order, layers: { ...Object.fromEntries(order.map((id) => [id, []])), ...layers } });
const props = (o: Record<string, Partial<LayerProps>> = {}): Record<string, LayerProps> =>
  Object.fromEntries(["A", "B", "C", "D"].map((id) => [id, { name: id, visible: true, opacity: 1, ...o[id] }]));

/** apply a move and read the panel top → bottom */
function after(order: string[], id: string, to: number | null): string {
  const s = state([...order]);
  if (to !== null) applyAction(s, { type: "move", id, to });
  return [...s.order].reverse().join("");
}

describe("layer order rules", () => {
  const order = ["A", "B", "C", "D"]; // panel shows D C B A

  it("menu moves: top, up one, down one, bottom", () => {
    expect(after(order, "B", moveTarget(order, "B", "top"))).toBe("BDCA");
    expect(after(order, "B", moveTarget(order, "B", "up"))).toBe("DBCA");
    expect(after(order, "B", moveTarget(order, "B", "down"))).toBe("DCAB");
    expect(after(order, "B", moveTarget(order, "B", "bottom"))).toBe("DCAB");
    expect(moveTarget(order, "D", "top")).toBeNull();
    expect(moveTarget(order, "D", "up")).toBeNull();
    expect(moveTarget(order, "A", "down")).toBeNull();
    expect(moveTarget(order, "A", "bottom")).toBeNull();
    expect(moveTarget(order, "X", "top")).toBeNull();
  });

  it("dragging a row into a gap of the panel", () => {
    // gaps: 0 above D, 1 between D and C, 2 between C and B, 3 between B and A, 4 below A
    expect(after(order, "B", dropTarget(order, "B", 0))).toBe("BDCA");
    expect(after(order, "B", dropTarget(order, "B", 4))).toBe("DCAB");
    expect(after(order, "D", dropTarget(order, "D", 2))).toBe("CDBA");
    expect(after(order, "D", dropTarget(order, "D", 4))).toBe("CBAD"); // across three layers
    expect(after(order, "A", dropTarget(order, "A", 1))).toBe("DACB");
    // dropping right above or below itself changes nothing
    expect(dropTarget(order, "C", 1)).toBeNull();
    expect(dropTarget(order, "C", 2)).toBeNull();
    expect(dropTarget(order, "X", 0)).toBeNull();
    expect(after(order, "C", dropTarget(order, "C", 99))).toBe("DBAC");
  });
});

describe("layer menu", () => {
  it("dims what cannot be done", () => {
    const s = state(["A", "B", "C"], { B: [{ kind: "bg", color: "#ffffff", holes: [] }], C: [{ kind: "stroke", brush: "pen", color: "#000000", size: 2, opacity: 1, pressure: false, seed: 1, points: [] }] });
    const top = layerMenuState(s, props(), "C", 10);
    expect(top).toMatchObject({ top: false, up: false, down: true, bottom: true, merge: true, clear: true, delete: true, duplicate: true });
    const bottom = layerMenuState(s, props(), "A", 10);
    expect(bottom).toMatchObject({ down: false, bottom: false, merge: false, clear: false });
    // a layer with only a colour has nothing to clear
    expect(layerMenuState(s, props(), "B", 10).clear).toBe(false);
    // full: no duplicate
    expect(layerMenuState(s, props(), "B", 3).duplicate).toBe(false);
    // the last layer cannot be deleted
    expect(layerMenuState(state(["A"]), props(), "A", 10).delete).toBe(false);
  });

  it("locked layers cannot be cleared, merged or deleted, nor merged into", () => {
    const s = state(["A", "B", "C"], { C: [{ kind: "bg", color: "#ffffff", holes: [{ kind: "stroke", brush: "eraserall", color: "#000000", size: 2, opacity: 1, pressure: false, seed: 1, points: [] }] }] });
    const m = layerMenuState(s, props({ C: { locked: true } }), "C", 10);
    expect(m).toMatchObject({ clear: false, merge: false, delete: false, top: false, down: true });
    expect(layerMenuState(s, props({ B: { locked: true } }), "C", 10).merge).toBe(false);
  });

  it("strokes need a layer that exists, is shown and is not locked", () => {
    const s = state(["A", "B"]);
    expect(drawBlock(s, props(), "A")).toBeNull();
    expect(drawBlock(s, props({ A: { locked: true } }), "A")).toBe("locked");
    expect(drawBlock(s, props({ A: { visible: false } }), "A")).toBe("hidden");
    expect(drawBlock(s, props(), "Z")).toBe("missing");
  });
});

describe("locked in stored works", () => {
  it("is optional, and must be true or false when present", () => {
    const doc = newWork({ layerName: "1" });
    expect(validateDoc(doc).ok).toBe(true);
    doc.layers.L1 = { ...doc.layers.L1!, locked: true };
    expect(validateDoc(doc).ok).toBe(true);
    (doc.layers.L1 as unknown as Record<string, unknown>).locked = "yes";
    expect(validateDoc(doc).ok).toBe(false);
  });
});
