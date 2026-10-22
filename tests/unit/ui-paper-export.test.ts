import { describe, expect, it } from "vitest";
import { cleanFileName, scaleOptions } from "../../src/ui/exporter";
import { resizeMove } from "../../src/ui/paperDialog";

describe("changing the paper size", () => {
  it("scale to fit: the whole drawing fits, centred", () => {
    expect(resizeMove({ w: 2400, h: 1600 }, { w: 1600, h: 2400 }, true, 4)).toEqual([2 / 3, 0, (2400 - 1600 * (2 / 3)) / 2]);
    expect(resizeMove({ w: 1000, h: 1000 }, { w: 2000, h: 1000 }, true, 0)).toEqual([1, 500, 0]);
  });
  it("keep the size: the drawing sits at the chosen anchor", () => {
    expect(resizeMove({ w: 2400, h: 1600 }, { w: 3000, h: 2000 }, false, 0)).toEqual([1, 0, 0]);
    expect(resizeMove({ w: 2400, h: 1600 }, { w: 3000, h: 2000 }, false, 4)).toEqual([1, 300, 200]);
    expect(resizeMove({ w: 2400, h: 1600 }, { w: 3000, h: 2000 }, false, 8)).toEqual([1, 600, 400]);
    expect(resizeMove({ w: 2400, h: 1600 }, { w: 1200, h: 800 }, false, 5)).toEqual([1, -1200, -400]);
  });
});

describe("export", () => {
  it("offers resolutions that stay within 16 million pixels", () => {
    const o = scaleOptions(2400, 1600);
    expect(o.map((x) => [x.key, x.ok])).toEqual([["1x", true], ["2x", true], ["4x", false], ["max", true]]);
    expect(o[3]!.d).toBeCloseTo(Math.sqrt(16e6 / (2400 * 1600)));
  });
  it("makes file names safe and keeps Thai", () => {
    expect(cleanFileName('a/b\\c:d*e?f"g<h>i|j', "x")).toBe("abcdefghij");
    expect(cleanFileName("ผลงาน 1.PNG", "x")).toBe("ผลงาน 1");
    expect(cleanFileName("  \u0001 ", "sketch")).toBe("sketch");
    expect(cleanFileName("x".repeat(200), "y")).toHaveLength(80);
  });
});
