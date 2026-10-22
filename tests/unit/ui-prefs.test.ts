import { describe, expect, it } from "vitest";
import { loadPrefs, parsePrefs, remember, savePrefs } from "../../src/ui/prefs";

describe("app settings in the browser", () => {
  it("bad or missing data falls back to defaults", () => {
    for (const raw of [null, "", "{", "[]", "42", '{"lastPaper":{"w":10,"h":10,"paper":"white"}}', '{"lastPaper":{"w":2400,"h":1600,"paper":"<b>"}}'])
      expect(parsePrefs(raw)).toEqual({ lastPaper: null, paperRecent: [] });
  });

  it("keeps good values and drops bad colours", () => {
    const p = parsePrefs(JSON.stringify({ lastPaper: { w: 3000, h: 5000, paper: "none" }, paperRecent: ["#AABBCC", "red", 3, "#112233", "#1", "#000000", "#111111", "#222222", "#333333"] }));
    expect(p.lastPaper).toEqual({ w: 3000, h: 5000, paper: "none" });
    expect(p.paperRecent).toEqual(["#aabbcc", "#112233", "#000000", "#111111", "#222222"]);
  });

  it("recent colours: newest first, no repeats, at most five", () => {
    let list: string[] = [];
    for (const c of ["#000001", "#000002", "#000003", "#000001", "#000004", "#000005", "#000006", "nope"]) list = remember(list, c);
    expect(list).toEqual(["#000006", "#000005", "#000004", "#000001", "#000003"]);
  });

  it("saves and loads through storage, and survives storage that throws", () => {
    const data = new Map<string, string>();
    const s = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    savePrefs({ lastPaper: { w: 1080, h: 1350, paper: "#fbf7ee" }, paperRecent: ["#fbf7ee"] }, s);
    expect(loadPrefs(s).lastPaper).toEqual({ w: 1080, h: 1350, paper: "#fbf7ee" });
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); } };
    expect(loadPrefs(broken)).toEqual({ lastPaper: null, paperRecent: [] });
    expect(() => savePrefs(loadPrefs(null), broken)).not.toThrow();
  });
});
