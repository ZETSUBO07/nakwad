import { describe, expect, it } from "vitest";
import { BRUSH_DEFAULTS, defaultPrefs, loadPrefs, parsePrefs, remember, savePrefs } from "../../src/ui/prefs";

describe("app settings in the browser", () => {
  it("bad or missing data falls back to defaults", () => {
    for (const raw of [null, "", "{", "[]", "42", '{"lastPaper":{"w":10,"h":10,"paper":"white"}}', '{"lastPaper":{"w":2400,"h":1600,"paper":"<b>"}}'])
      expect(parsePrefs(raw)).toEqual(defaultPrefs());
  });

  it("defaults follow the spec: left hand, pen draws, low smoothing, bright font, pen tool", () => {
    const p = defaultPrefs();
    expect([p.hand, p.finger, p.font, p.brush]).toEqual(["left", "pen", "bright", "pen"]);
    expect(p.stab).toBeLessThanOrEqual(25);
    expect(p.brushes).toEqual(BRUSH_DEFAULTS);
    p.brushes.pen.size = 50;
    expect(BRUSH_DEFAULTS.pen.size).toBe(4); // defaults are copied, never shared
  });

  it("keeps good values, clamps numbers and drops bad ones", () => {
    const p = parsePrefs(JSON.stringify({
      lastPaper: { w: 3000, h: 5000, paper: "none" },
      paperRecent: ["#AABBCC", "red", 3, "#112233", "#1", "#000000", "#111111", "#222222", "#333333"],
      hand: "right", finger: "draw", font: "brush", stab: 250, brush: "marker", color: "#ABCDEF", colorRecent: ["#010203"],
      brushes: { pen: { size: 500, op: 1 }, ink: { size: "big" }, nope: { size: 3, op: 50 } },
      toolbar: { land: { size: "compact", side: "top", along: 0.5, x: 0, y: 0 }, port: { size: "huge", side: "left", along: 0, x: 0, y: 0 } },
    }));
    expect(p.lastPaper).toEqual({ w: 3000, h: 5000, paper: "none" });
    expect(p.paperRecent).toEqual(["#aabbcc", "#112233", "#000000", "#111111", "#222222"]);
    expect([p.hand, p.finger, p.font, p.stab, p.brush, p.color]).toEqual(["right", "draw", "brush", 100, "marker", "#abcdef"]);
    expect(p.colorRecent).toEqual(["#010203"]);
    expect(p.brushes.pen).toEqual({ size: 300, op: 5 });
    expect(p.brushes.ink).toEqual(BRUSH_DEFAULTS.ink);
    expect(p.toolbar.land).toEqual({ size: "compact", side: "top", along: 0.5, x: 0, y: 0 });
    expect(p.toolbar.port).toBeUndefined();
    expect(parsePrefs(JSON.stringify({ hand: "middle", brush: "laser", color: "red", stab: "x" }))).toEqual(defaultPrefs());
  });

  it("the old default smoothing of 20 becomes the new low default; a 20 chosen since is kept", () => {
    expect(parsePrefs(JSON.stringify({ stab: 20 })).stab).toBe(5);
    expect(parsePrefs(JSON.stringify({ stab: 35 })).stab).toBe(35);
    expect(parsePrefs(JSON.stringify({ stab: 20, v: 2 })).stab).toBe(20);
    const data = new Map<string, string>();
    const s = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    savePrefs({ ...defaultPrefs(), stab: 20 }, s);
    expect(loadPrefs(s).stab).toBe(20);
  });

  it("recent colours: newest first, no repeats, at most five", () => {
    let list: string[] = [];
    for (const c of ["#000001", "#000002", "#000003", "#000001", "#000004", "#000005", "#000006", "nope"]) list = remember(list, c);
    expect(list).toEqual(["#000006", "#000005", "#000004", "#000001", "#000003"]);
  });

  it("saves and loads through storage, and survives storage that throws", () => {
    const data = new Map<string, string>();
    const s = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    savePrefs({ ...defaultPrefs(), lastPaper: { w: 1080, h: 1350, paper: "#fbf7ee" }, hand: "right" }, s);
    expect(loadPrefs(s).lastPaper).toEqual({ w: 1080, h: 1350, paper: "#fbf7ee" });
    expect(loadPrefs(s).hand).toBe("right");
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); } };
    expect(loadPrefs(broken)).toEqual(defaultPrefs());
    expect(() => savePrefs(loadPrefs(null), broken)).not.toThrow();
  });
});
