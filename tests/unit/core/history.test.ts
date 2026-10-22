import { describe, expect, it } from "vitest";
import { HISTORY_LIMIT, canRedo, canUndo, commit, derive, fold, redo, replaceLast, undo } from "../../../src/core";
import { draw, page, stroke } from "./helpers";

describe("undo and redo", () => {
  it("undoes and redoes in order, and a new step clears redo", () => {
    let p = commit(commit(page(), draw("L1", stroke("pen"))), draw("L1", stroke("marker")));
    expect(canUndo(p)).toBe(true);
    p = undo(p);
    expect(derive(p).layers.L1).toEqual([stroke("pen")]);
    expect(canRedo(p)).toBe(true);
    p = redo(p);
    expect(derive(p).layers.L1).toHaveLength(2);
    p = commit(undo(p), draw("L1", stroke("ink")));
    expect(canRedo(p)).toBe(false);
  });

  it("does nothing with nothing to undo or redo", () => {
    const p = page();
    expect(undo(p)).toBe(p);
    expect(redo(p)).toBe(p);
  });

  it("replaceLast keeps a drag as one step", () => {
    let p = replaceLast(page(), { type: "bg", layer: "L1", color: "#000001" });
    p = replaceLast(p, { type: "bg", layer: "L1", color: "#000002" });
    p = replaceLast(p, { type: "bg", layer: "L1", color: "#000003" });
    expect(p.actions).toHaveLength(1);
    expect(derive(p).layers.L1?.[0]).toMatchObject({ color: "#000003" });
  });
});

describe("history limit", () => {
  it(`keeps ${HISTORY_LIMIT} steps and folds older ones into the base without changing the picture`, () => {
    let p = page();
    for (let i = 0; i < HISTORY_LIMIT + 30; i++) p = commit(p, draw("L1", stroke("pen", { seed: i })));
    expect(p.actions).toHaveLength(HISTORY_LIMIT);
    expect(derive(p).layers.L1).toHaveLength(HISTORY_LIMIT + 30);
    expect(p.base.layers.L1).toHaveLength(30);
  });

  it("folding keeps only live layers and the current paper size", () => {
    let p = commit(page(), { type: "add", id: "L2", index: 1 });
    p = commit(p, { type: "del", id: "L2" });
    p = commit(p, { type: "resize", w: 1000, h: 800, m: [1, 0, 0] });
    const folded = fold(p, 3);
    expect(folded.base).toMatchObject({ w: 1000, h: 800, order: ["L1"] });
    expect(Object.keys(folded.base.layers)).toEqual(["L1"]);
    const visible = (s: ReturnType<typeof derive>) => ({ w: s.w, h: s.h, order: s.order, layers: s.order.map((id) => s.layers[id]) });
    expect(visible(derive(folded))).toEqual(visible(derive(p)));
    expect(fold(p, 0)).toBe(p);
  });
});
