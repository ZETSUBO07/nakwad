import { describe, expect, it } from "vitest";
import { LIMITS, commit, newWork, validateDoc, type Action, type WorkDoc } from "../../../src/core";
import { draw, stroke, textData } from "./helpers";

const fullDoc = (): WorkDoc => {
  const doc = newWork({ layerName: "Layer 1" });
  doc.layers.L2 = { name: "Text", visible: true, opacity: 0.5 };
  doc.layers.L3 = { name: "White", visible: true, opacity: 1 };
  let p = doc.pages[0]!;
  const actions: Action[] = [
    draw("L1", stroke("pencil", { mask: { pts: [[0, 0], [10, 0], [10, 10]], inv: false }, vs: 0.4 })),
    draw("L1", { kind: "lineset", color: "#000000", opacity: 1, paths: [{ pts: [0, 0, 2, 5, 5, 3], v: true, a: 1 }, { pts: [0, 0, 9, 9], v: false, w: 2, a: 0.5 }] }),
    draw("L1", { kind: "selmove", mask: { pts: [[0, 0], [5, 0], [5, 5]], inv: true }, dx: 3, dy: -2 }),
    draw("L1", { kind: "selerase", mask: { pts: [[0, 0], [5, 0], [5, 5]], inv: false } }),
    draw("L1", { kind: "replace", img: "I1", w: 2400, h: 1600 }),
    { type: "add", id: "L2", index: 1, text: textData() },
    { type: "textset", layer: "L2", tid: "T1", text: textData({ align: "center", rot: 15 }) },
    { type: "bg", layer: "L1", color: "#cfe3ff" },
    { type: "xform", layer: "L1", m: [1.5, 10, -10] },
    { type: "resize", w: 1600, h: 2400, m: [0.5, 0, 0] },
    { type: "move", id: "L2", to: 0 },
    { type: "merge", id: "L2", into: "L1", alpha: 1 },
    { type: "clear", layer: "L1" },
    { type: "textflat", layer: "L2", tid: "T1", img: "I2", w: 10, h: 10 },
    { type: "del", id: "L2" },
    { type: "add", id: "L3", index: 1, color: "#ffffff" },
  ];
  for (const a of actions) p = commit(p, a);
  p.base.layers.L1 = [{ kind: "bg", color: "#ffffff", holes: [stroke("eraserall")] }, { kind: "group", items: [stroke()], opacity: 1, m: [1, 0, 0], src: [100, 100] }, { kind: "image", img: "I3", x: 0, y: 0, w: 5, h: 5, opacity: 1 }];
  doc.pages[0] = p;
  return doc;
};

const broken = (edit: (d: WorkDoc & Record<string, unknown>) => void): string[] => {
  const d = structuredClone(fullDoc()) as WorkDoc & Record<string, unknown>;
  edit(d);
  const r = validateDoc(d);
  return r.ok ? [] : r.errors;
};

describe("validateDoc", () => {
  it("accepts a work that uses every kind of entry and action, and survives JSON round trips", () => {
    const r = validateDoc(JSON.parse(JSON.stringify(fullDoc())));
    expect(r.ok ? [] : r.errors).toEqual([]);
  });

  it("rejects things that are not works", () => {
    for (const v of [null, 5, "x", [], {}]) expect(validateDoc(v).ok).toBe(false);
    expect(validateDoc({ ...fullDoc(), schema: 2 })).toMatchObject({ ok: false });
    expect(validateDoc({ ...fullDoc(), pages: [] })).toMatchObject({ ok: false });
  });

  it.each([
    ["bad paper colour", (d: WorkDoc) => { d.paper = "javascript:alert(1)"; }],
    ["current page out of range", (d: WorkDoc) => { d.current = 3; }],
    ["bad counters", (d: WorkDoc) => { (d.next as Record<string, unknown>).layer = -1; }],
    ["layer settings", (d: WorkDoc) => { d.layers.L1 = { name: "x", visible: true, opacity: 2 }; }],
    ["layer without settings", (d: WorkDoc) => { delete d.layers.L1; }],
    ["huge paper", (d: WorkDoc) => { d.pages[0]!.base.w = 99999; }],
    ["repeated layer", (d: WorkDoc) => { d.pages[0]!.base.order = ["L1", "L1"]; }],
    ["colour not first", (d: WorkDoc) => { d.pages[0]!.base.layers.L1!.reverse(); }],
    ["unknown brush", (d: WorkDoc) => { (d.pages[0]!.actions[0] as { entry: { brush: string } }).entry.brush = "laser"; }],
    ["NaN point", (d: WorkDoc) => { (d.pages[0]!.actions[0] as { entry: { points: number[][] } }).entry.points[0]![0] = Number.NaN; }],
    ["pressure out of range", (d: WorkDoc) => { (d.pages[0]!.actions[0] as { entry: { points: number[][] } }).entry.points[0]![2] = 7; }],
    ["bad mask", (d: WorkDoc) => { (d.pages[0]!.actions[0] as { entry: { mask: unknown } }).entry.mask = { pts: [[0, 0]], inv: false }; }],
    ["unknown action", (d: WorkDoc) => { (d.pages[0]!.actions[1] as { type: string }).type = "explode"; }],
    ["bad text colour", (d: WorkDoc) => { (d.pages[0]!.actions[6] as { text: { color: string } }).text.color = "red"; }],
    ["text too long", (d: WorkDoc) => { (d.pages[0]!.actions[6] as { text: { text: string } }).text.text = "x".repeat(LIMITS.textLength + 1); }],
    ["bad id", (d: WorkDoc) => { (d.pages[0]!.actions[1] as { layer: string }).layer = "../../etc"; }],
    ["bad move scale", (d: WorkDoc) => { (d.pages[0]!.actions[8] as { m: number[] }).m = [0, 0, 0]; }],
    ["bad resize", (d: WorkDoc) => { (d.pages[0]!.actions[9] as { w: number }).w = 10; }],
    ["bad redo step", (d: WorkDoc) => { d.pages[0]!.redo = [{ type: "nope" } as never]; }],
    ["unknown entry", (d: WorkDoc) => { d.pages[0]!.base.layers.L1!.push({ kind: "virus" } as never); }],
  ])("rejects %s", (_name, edit) => {
    expect(broken(edit as (d: WorkDoc & Record<string, unknown>) => void).length).toBeGreaterThan(0);
  });

  it("refuses groups nested deeper than the limit", () => {
    const doc = fullDoc();
    let deep: unknown = stroke();
    for (let i = 0; i <= LIMITS.groupDepth + 1; i++) deep = { kind: "group", items: [deep], opacity: 1 };
    doc.pages[0]!.base.layers.L1!.push(deep as never);
    expect(validateDoc(doc).ok).toBe(false);
  });

  it("stops after a bounded number of messages", () => {
    const doc = fullDoc();
    doc.pages[0]!.base.layers.L1 = Array.from({ length: 500 }, () => ({ kind: "bogus" }) as never);
    const r = validateDoc(doc);
    expect(r.ok ? 0 : r.errors.length).toBeLessThanOrEqual(50);
  });
});

describe("validateDoc: every rule", () => {
  const S = stroke();
  const T = textData();
  const M = { pts: [[0, 0], [5, 0], [5, 5]], inv: false };
  const badEntries: [string, unknown][] = [
    ["not an object", 5],
    ["stroke colour", { ...S, color: "blue" }],
    ["stroke settings", { ...S, opacity: 3 }],
    ["stroke view scale", { ...S, vs: -1 }],
    ["stroke without points", { ...S, points: [] }],
    ["stroke point shape", { ...S, points: [[1, 2, 0.5]] }],
    ["picture", { kind: "image", img: "I1", x: 0, y: 0, w: 0, h: 1, opacity: 1 }],
    ["replace", { kind: "replace", img: "bad id!", w: 1, h: 1 }],
    ["selection erase", { kind: "selerase", mask: "everything" }],
    ["selection move offset", { kind: "selmove", mask: M, dx: Infinity, dy: 0 }],
    ["mask point", { kind: "selerase", mask: { pts: [[0, 0], [1, 1], [2]], inv: false } }],
    ["line set", { kind: "lineset", color: "#000000", opacity: 1, paths: "x" }],
    ["line", { kind: "lineset", color: "#000000", opacity: 1, paths: [{ pts: [], a: 1 }] }],
    ["line point", { kind: "lineset", color: "#000000", opacity: 1, paths: [{ pts: [0, "x"], v: true, a: 1 }] }],
    ["line width", { kind: "lineset", color: "#000000", opacity: 1, paths: [{ pts: [0, 0, 1, 1], v: false, a: 1 }] }],
    ["line count", { kind: "lineset", color: "#000000", opacity: 1, paths: [{ pts: new Array(LIMITS.lineSetNumbers + 1).fill(0), v: true, a: 1 }] }],
    ["group", { kind: "group", items: [], opacity: 9 }],
    ["group move", { kind: "group", items: [], opacity: 1, m: [1, 2] }],
    ["group size", { kind: "group", items: [], opacity: 1, src: [0, 5] }],
    ["layer colour", { kind: "bg", color: "#zzzzzz", holes: [] }],
    ["text id", { kind: "text", ...T, tid: "" }],
    ["text position", { kind: "text", ...T, x: "1" }],
    ["text font", { kind: "text", ...T, font: "" }],
    ["text size", { kind: "text", ...T, size: 0 }],
    ["text align", { kind: "text", ...T, align: "justify" }],
    ["text rotation", { kind: "text", ...T, rot: 999 }],
    ["text not an object", { kind: "text", ...T, text: 5 }],
  ];
  it.each(badEntries)("rejects a bad entry: %s", (_n, e) => {
    const doc = fullDoc();
    doc.pages[0]!.base.layers.L1!.push(e as never);
    expect(validateDoc(doc).ok).toBe(false);
  });

  const badActions: [string, unknown][] = [
    ["not an object", null],
    ["add index", { type: "add", id: "L5", index: -1 }],
    ["add copy id", { type: "add", id: "L5", index: 0, copyOf: "../x" }],
    ["add picture", { type: "add", id: "L5", index: 0, image: { kind: "stroke" } }],
    ["add text", { type: "add", id: "L5", index: 0, text: { ...T, color: 1 } }],
    ["add colour", { type: "add", id: "L5", index: 0, color: "white" }],
    ["delete", { type: "del", id: 7 }],
    ["move", { type: "move", id: "L1", to: 1.5 }],
    ["merge", { type: "merge", id: "L1", into: "L2", alpha: 2 }],
    ["draw kind", { type: "draw", layer: "L1", entry: { kind: "bg", color: "#000000", holes: [] } }],
    ["clear", { type: "clear" }],
    ["move layer id", { type: "xform", layer: "", m: [1, 0, 0] }],
    ["layer colour", { type: "bg", layer: "L1", color: "pink" }],
    ["text change ids", { type: "textset", layer: "L1", tid: "" , text: null }],
    ["text change content", { type: "textset", layer: "L1", tid: "T1", text: { ...T, size: -2 } }],
    ["text to picture", { type: "textflat", layer: "L1", tid: "T1", img: "I1", w: 0, h: 1 }],
  ];
  it.each(badActions)("rejects a bad action: %s", (_n, a) => {
    const doc = fullDoc();
    doc.pages[0]!.actions.push(a as never);
    expect(validateDoc(doc).ok).toBe(false);
  });

  it.each([
    ["not a page", (d: WorkDoc) => { d.pages[0] = 5 as never; }],
    ["layer list", (d: WorkDoc) => { d.pages[0]!.base.order = "L1" as never; }],
    ["layer contents missing", (d: WorkDoc) => { d.pages[0]!.base.layers = 5 as never; }],
    ["layer missing from contents", (d: WorkDoc) => { delete d.pages[0]!.base.layers.L1; }],
    ["too many steps", (d: WorkDoc) => { d.pages[0]!.redo = new Array(LIMITS.actions).fill({ type: "del", id: "L1" }); }],
    ["layer settings missing", (d: WorkDoc) => { d.layers = 5 as never; }],
    ["added layer without settings", (d: WorkDoc) => { d.pages[0]!.actions.push({ type: "add", id: "L77", index: 0 }); }],
  ])("rejects a bad page or work: %s", (_n, edit) => {
    expect(broken(edit as (d: WorkDoc & Record<string, unknown>) => void).length).toBeGreaterThan(0);
  });

  it("rejects strokes with too many points without reading them all", () => {
    const doc = fullDoc();
    doc.pages[0]!.base.layers.L1!.push({ ...S, points: new Array(LIMITS.pointsPerStroke + 1).fill([0, 0, 0, 0]) });
    expect(validateDoc(doc).ok).toBe(false);
  });
});
