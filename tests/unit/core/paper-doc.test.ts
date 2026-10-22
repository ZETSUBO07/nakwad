import { describe, expect, it } from "vitest";
import { PAPER_SIZES, imagesInUse, isPaperColor, layersFor, newWork, nextId, paperFill, paperSizeProblem, validateDoc, commit } from "../../../src/core";
import { draw } from "./helpers";

describe("paper", () => {
  it("matches the layer counts shown in the prototype", () => {
    const counts = Object.fromEntries(PAPER_SIZES.map((p) => [p.id, layersFor(p.w, p.h)]));
    expect(counts).toEqual({ landscape: 26, portrait: 26, square: 23, padScreen: 16, a4: 11, a5: 23, social: 68 });
  });

  it("explains why a size cannot be used", () => {
    expect(paperSizeProblem(2400, 1600)).toBeNull();
    expect(paperSizeProblem(10.5, 100)).toBe("notInteger");
    expect(paperSizeProblem(63, 100)).toBe("tooSmall");
    expect(paperSizeProblem(6001, 100)).toBe("tooLarge");
    expect(paperSizeProblem(5000, 5000)).toBe("areaTooLarge");
  });

  it("knows paper colours", () => {
    for (const ok of ["white", "cream", "none", "#CFE3FF"]) expect(isPaperColor(ok)).toBe(true);
    for (const bad of ["red", "#fff", "", 5, null]) expect(isPaperColor(bad)).toBe(false);
    expect(paperFill("cream")).toBe("#fbf7ee");
    expect(paperFill("none")).toBe("#ffffff");
    expect(paperFill("#CFE3FF")).toBe("#cfe3ff");
  });
});

describe("works", () => {
  it("creates a valid work with one page and one named layer", () => {
    const doc = newWork({ w: 1080, h: 1350, paper: "cream", layerName: "Layer 1" });
    expect(doc.pages).toHaveLength(1);
    expect(doc.pages[0]?.base).toMatchObject({ w: 1080, h: 1350, order: ["L1"] });
    expect(doc.layers.L1).toEqual({ name: "Layer 1", visible: true, opacity: 1 });
    expect(validateDoc(doc).ok).toBe(true);
  });

  it("uses the default size and refuses impossible sizes", () => {
    expect(newWork({ layerName: "x" }).pages[0]?.base.w).toBe(2400);
    expect(() => newWork({ w: 9000, h: 10, layerName: "x" })).toThrow(RangeError);
  });

  it("never repeats ids", () => {
    const doc = newWork({ layerName: "x" });
    expect([nextId(doc, "layer"), nextId(doc, "layer"), nextId(doc, "image"), nextId(doc, "page")]).toEqual(["L2", "L3", "I1", "P2"]);
  });

  it("lists every picture still in use, including steps that can be redone", () => {
    const doc = newWork({ layerName: "x" });
    const pg = doc.pages[0]!;
    let p = commit(pg, draw("L1", { kind: "image", img: "I1", x: 0, y: 0, w: 1, h: 1, opacity: 1 }));
    p = commit(p, { type: "add", id: "L2", index: 1, image: { kind: "image", img: "I2", x: 0, y: 0, w: 1, h: 1, opacity: 1 } });
    p = commit(p, { type: "textflat", layer: "L1", tid: "T1", img: "I3", w: 1, h: 1 });
    p = commit(p, draw("L1", { kind: "replace", img: "I4", w: 1, h: 1 }));
    p = { ...p, actions: p.actions.slice(0, -1), redo: [p.actions[p.actions.length - 1]!] };
    p.base.layers.L1 = [{ kind: "group", opacity: 1, items: [{ kind: "image", img: "I5", x: 0, y: 0, w: 1, h: 1, opacity: 1 }] }, { kind: "bg", color: "#000000", holes: [] }];
    doc.pages[0] = p;
    expect([...imagesInUse(doc)].sort()).toEqual(["I1", "I2", "I3", "I4", "I5"]);
  });
});
