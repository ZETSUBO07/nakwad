import { describe, expect, it } from "vitest";
import { applyAction, bgOf, commit, derive, mul, validActive, type Action, type Page } from "../../../src/core";
import { draw, page, stroke, textData } from "./helpers";

const run = (p: Page, ...actions: Action[]) => derive(actions.reduce((acc, a) => commit(acc, a), p));

describe("layers", () => {
  it("starts from the base", () => {
    const s = derive(page());
    expect(s).toMatchObject({ w: 2400, h: 1600, order: ["L1"] });
    expect(s.layers.L1).toEqual([]);
  });

  it("adds, moves and deletes layers, clamping positions", () => {
    const s = run(page(), { type: "add", id: "L2", index: 99 }, { type: "add", id: "L3", index: 0 }, { type: "move", id: "L3", to: 5 }, { type: "del", id: "L1" });
    expect(s.order).toEqual(["L2", "L3"]);
  });

  it("a new layer can start filled with a colour", () => {
    const s = run(page(), { type: "add", id: "L2", index: 1, color: "#ffffff" });
    expect(s.layers.L2).toEqual([{ kind: "bg", color: "#ffffff", holes: [] }]);
    expect(bgOf(s.layers.L2)?.color).toBe("#ffffff");
  });

  it("ignores moves of layers that do not exist", () => {
    expect(run(page(), { type: "move", id: "nope", to: 0 }).order).toEqual(["L1"]);
  });

  it("copies a layer's content when duplicating", () => {
    const s = run(page(), draw("L1"), { type: "add", id: "L2", index: 1, copyOf: "L1" });
    expect(s.layers.L2).toEqual(s.layers.L1);
    expect(s.layers.L2).not.toBe(s.layers.L1);
  });

  it("starts a layer from a picture", () => {
    const img = { kind: "image", img: "I1", x: 0, y: 0, w: 10, h: 10, opacity: 1 } as const;
    expect(run(page(), { type: "add", id: "L2", index: 1, image: img }).layers.L2).toEqual([img]);
  });

  it("merges the upper layer into the lower as one group and removes it", () => {
    const s = run(page(), { type: "add", id: "L2", index: 1 }, draw("L2"), { type: "merge", id: "L2", into: "L1", alpha: 0.5 });
    expect(s.order).toEqual(["L1"]);
    expect(s.layers.L1).toEqual([{ kind: "group", items: [stroke()], opacity: 0.5 }]);
  });

  it("does not merge layers that are gone", () => {
    const s = run(page(), { type: "merge", id: "L9", into: "L1", alpha: 1 });
    expect(s.layers.L1).toEqual([]);
  });

  it("clears a layer", () => {
    expect(run(page(), draw("L1"), { type: "clear", layer: "L1" }).layers.L1).toEqual([]);
  });

  it("ignores drawing on a deleted layer", () => {
    const s = run(page(), { type: "add", id: "L2", index: 1 }, { type: "del", id: "L2" }, draw("L2"));
    expect(s.layers.L2).toEqual([]);
  });

  it("picks a valid active layer", () => {
    const s = derive(page());
    expect(validActive(s, "L1")).toBe("L1");
    expect(validActive(s, "gone")).toBe("L1");
  });
});

describe("move and paper resize", () => {
  it("wraps content in a moved group and combines repeated moves", () => {
    const s = run(page(), draw("L1"), { type: "xform", layer: "L1", m: [2, 10, 0] }, { type: "xform", layer: "L1", m: [1, 5, 5] });
    expect(s.layers.L1).toEqual([{ kind: "group", items: [stroke()], opacity: 1, m: mul([1, 5, 5], [2, 10, 0]) }]);
    expect(mul([1, 5, 5], [2, 10, 0])).toEqual([2, 15, 5]);
  });

  it("leaves an empty layer alone when moved", () => {
    expect(run(page(), { type: "xform", layer: "L1", m: [2, 0, 0] }).layers.L1).toEqual([]);
  });

  it("resizes the paper and keeps the old size so strokes can be redrawn sharp", () => {
    const s = run(page(), draw("L1"), { type: "resize", w: 1600, h: 2400, m: [0.5, 0, 0] });
    expect([s.w, s.h]).toEqual([1600, 2400]);
    expect(s.layers.L1).toEqual([{ kind: "group", items: [stroke()], opacity: 1, m: [0.5, 0, 0], src: [2400, 1600] }]);
  });

  it("undo across a resize brings the old paper size back", () => {
    let p = commit(page(), { type: "resize", w: 1000, h: 1000, m: [1, 0, 0] });
    expect(derive(p).w).toBe(1000);
    p = { ...p, actions: [] };
    expect(derive(p).w).toBe(2400);
  });
});

describe("layer colour and the two erasers", () => {
  it("sets, changes and removes a layer colour, always first", () => {
    let s = run(page(), draw("L1"), { type: "bg", layer: "L1", color: "#cfe3ff" });
    expect(s.layers.L1?.[0]).toEqual({ kind: "bg", color: "#cfe3ff", holes: [] });
    s = run(page(), draw("L1"), { type: "bg", layer: "L1", color: "#cfe3ff" }, { type: "bg", layer: "L1", color: "#ffe3ec" });
    expect(s.layers.L1?.filter((e) => e.kind === "bg")).toHaveLength(1);
    expect(bgOf(s.layers.L1)?.color).toBe("#ffe3ec");
    s = run(page(), draw("L1"), { type: "bg", layer: "L1", color: "#cfe3ff" }, { type: "bg", layer: "L1", color: null });
    expect(bgOf(s.layers.L1)).toBeNull();
    expect(s.layers.L1).toEqual([stroke()]);
  });

  it("the stroke eraser leaves the colour whole; erase-everything cuts a hole", () => {
    const e1 = stroke("eraser"), e2 = stroke("eraserall");
    const s = run(page(), { type: "bg", layer: "L1", color: "#cfe3ff" }, draw("L1", e1), draw("L1", e2));
    expect(bgOf(s.layers.L1)?.holes).toEqual([e2]);
    expect(s.layers.L1?.slice(1)).toEqual([e1, e2]);
  });

  it("a new colour starts without holes", () => {
    const s = run(page(), { type: "bg", layer: "L1", color: "#cfe3ff" }, draw("L1", stroke("eraserall")), { type: "bg", layer: "L1", color: "#000000" });
    expect(bgOf(s.layers.L1)?.holes).toEqual([]);
  });

  it("clearing keeps the colour and fills the holes", () => {
    const s = run(page(), { type: "bg", layer: "L1", color: "#cfe3ff" }, draw("L1", stroke("eraserall")), { type: "clear", layer: "L1" });
    expect(s.layers.L1).toEqual([{ kind: "bg", color: "#cfe3ff", holes: [] }]);
  });

  it("moving keeps the colour full-size while the holes move with the content", () => {
    const hole = stroke("eraserall");
    const s = run(page(), { type: "bg", layer: "L1", color: "#cfe3ff" }, draw("L1"), draw("L1", hole), { type: "xform", layer: "L1", m: [1, 50, 0] });
    const L = s.layers.L1 ?? [];
    expect(L[0]).toEqual({ kind: "bg", color: "#cfe3ff", holes: [{ kind: "group", items: [hole], opacity: 1, m: [1, 50, 0] }] });
    expect(L[1]).toMatchObject({ kind: "group", m: [1, 50, 0] });
  });

  it("merging bakes the upper layer's colour into the lower layer", () => {
    const s = run(page(), { type: "add", id: "L2", index: 1 }, { type: "bg", layer: "L2", color: "#cfe3ff" }, { type: "merge", id: "L2", into: "L1", alpha: 1 });
    expect(s.layers.L1).toEqual([{ kind: "group", items: [{ kind: "bg", color: "#cfe3ff", holes: [] }], opacity: 1 }]);
    expect(bgOf(s.layers.L1)).toBeNull();
  });

  it("duplicating copies the colour", () => {
    const s = run(page(), { type: "bg", layer: "L1", color: "#cfe3ff" }, { type: "add", id: "L2", index: 1, copyOf: "L1" });
    expect(bgOf(s.layers.L2)?.color).toBe("#cfe3ff");
  });
});

describe("text", () => {
  it("adds a text layer, edits it, and deletes the text", () => {
    let s = run(page(), { type: "add", id: "L2", index: 1, text: textData() });
    expect(s.layers.L2).toEqual([{ kind: "text", ...textData() }]);
    s = run(page(), { type: "add", id: "L2", index: 1, text: textData() }, { type: "textset", layer: "L2", tid: "T1", text: textData({ text: "edited", font: "Mali" }) });
    expect(s.layers.L2?.[0]).toMatchObject({ kind: "text", text: "edited", font: "Mali" });
    s = run(page(), { type: "add", id: "L2", index: 1, text: textData() }, { type: "textset", layer: "L2", tid: "T1", text: null });
    expect(s.layers.L2).toEqual([]);
  });

  it("ignores edits to text that is not there", () => {
    const s = run(page(), { type: "textset", layer: "L1", tid: "T9", text: null }, { type: "textset", layer: "L9", tid: "T1", text: null });
    expect(s.layers.L1).toEqual([]);
  });

  it("stays editable text after moving the layer and after resizing the paper", () => {
    const s = run(page(), { type: "add", id: "L2", index: 1, text: textData() }, { type: "xform", layer: "L2", m: [2, 10, 20] }, { type: "resize", w: 1200, h: 800, m: [0.5, 0, 0] });
    expect(s.layers.L2?.[0]).toEqual({ kind: "text", ...textData({ x: (2 * 100 + 10) * 0.5, y: (2 * 200 + 20) * 0.5, size: 72 }) });
  });

  it("text mixed with strokes is grouped like other content", () => {
    const s = run(page(), { type: "add", id: "L2", index: 1, text: textData() }, draw("L2"), { type: "xform", layer: "L2", m: [1, 5, 5] });
    expect(s.layers.L2?.[0]).toMatchObject({ kind: "group" });
  });

  it("turns text into a picture", () => {
    const s = run(page(), { type: "add", id: "L2", index: 1, text: textData() }, { type: "textflat", layer: "L2", tid: "T1", img: "I1", w: 2400, h: 1600 });
    expect(s.layers.L2).toEqual([{ kind: "image", img: "I1", x: 0, y: 0, w: 2400, h: 1600, opacity: 1 }]);
  });
});

describe("derive is pure", () => {
  it("does not change the page or its base", () => {
    const p = commit(commit(page(), draw("L1")), { type: "bg", layer: "L1", color: "#cfe3ff" });
    const before = JSON.stringify(p);
    derive(p);
    derive(p);
    expect(JSON.stringify(p)).toBe(before);
  });

  it("applyAction on a copied state leaves the source alone", () => {
    const s = derive(page());
    const copy = { ...s, order: [...s.order], layers: { L1: [...(s.layers.L1 ?? [])] } };
    applyAction(copy, draw("L1"));
    expect(s.layers.L1).toEqual([]);
  });
});
