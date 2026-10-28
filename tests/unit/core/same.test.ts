import { describe, expect, it } from "vitest";
import { commit, derive, sameEntries, undo, type Action, type Page } from "../../../src/core";
import { draw, page, stroke, textData } from "./helpers";

const run = (p: Page, ...a: Action[]) => a.reduce((q, x) => commit(q, x), p);

describe("same layer content (skip redrawing untouched layers)", () => {
  it("plain lists: same objects are the same, anything else is not", () => {
    const a = stroke(), b = stroke();
    expect(sameEntries([a], [a])).toBe(true);
    expect(sameEntries(undefined, undefined)).toBe(true);
    expect(sameEntries([a], undefined)).toBe(false);
    expect(sameEntries([a], [a, a])).toBe(false);
    expect(sameEntries([a], [b])).toBe(false); // equal looking, but not known to be the same: draw again
    expect(sameEntries([a], [{ kind: "image", img: "I1", x: 0, y: 0, w: 1, h: 1, opacity: 1 }])).toBe(false);
  });

  it("after undoing a stroke on one layer, only that layer differs", () => {
    let p = run(page(), { type: "add", id: "L2", index: 1, color: "#ffffff" }, draw("L1"), draw("L2"), draw("L1"));
    const before = derive(p);
    p = undo(p);
    const after = derive(p);
    expect(sameEntries(before.layers.L2, after.layers.L2)).toBe(true);
    expect(sameEntries(before.layers.L1, after.layers.L1)).toBe(false);
  });

  it("wrappers made anew on every replay compare by their fields", () => {
    // moved layers and merged layers are wrapped in groups; layer colours keep their holes
    let p = run(page(), { type: "add", id: "L2", index: 1, color: "#ffffff" }, draw("L1"), draw("L2"),
      draw("L2", stroke("eraserall")), { type: "xform", layer: "L1", m: [2, 5, 5] },
      { type: "add", id: "L3", index: 2 }, draw("L3"), { type: "merge", id: "L3", into: "L1", alpha: 0.5 },
      { type: "add", id: "L4", index: 2, text: textData() }, { type: "xform", layer: "L4", m: [1, 10, 0] });
    const a = derive(p), b = derive(p);
    for (const id of a.order) expect(sameEntries(a.layers[id], b.layers[id])).toBe(true);
    // a different move, colour or text is not the same
    const moved = derive(run(p, { type: "xform", layer: "L1", m: [1, 1, 1] }));
    expect(sameEntries(a.layers.L1, moved.layers.L1)).toBe(false);
    const recolored = derive(run(p, { type: "bg", layer: "L2", color: "#000000" }));
    expect(sameEntries(a.layers.L2, recolored.layers.L2)).toBe(false);
    const retexted = derive(run(p, { type: "textset", layer: "L4", tid: "T1", text: textData({ text: "bye" }) }));
    expect(sameEntries(a.layers.L4, retexted.layers.L4)).toBe(false);
    p = run(p, { type: "merge", id: "L2", into: "L1", alpha: 0.4 });
    const m1 = derive(p), m2 = derive(run(undo(p), { type: "merge", id: "L2", into: "L1", alpha: 0.6 }));
    expect(sameEntries(m1.layers.L1, m2.layers.L1)).toBe(false);
  });
});
